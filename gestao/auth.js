import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cfg = window.CONNECTPLUS_SUPABASE || {};
const gate = document.getElementById('secureGate');
const app = document.getElementById('appRoot');
const msg = document.getElementById('gateMessage');
const form = document.getElementById('loginForm');
const localKey = 'connectplus-platform-v1';
const recoveryKey = 'connectplus-platform-v1-recovery';
let supabase, currentRevision = null, teamRevision = null, memberRole = null, splitStorage = false;
let pendingState = null, saveTimer = null, saveChain = Promise.resolve();
let loadingState = false;
let passwordRecoveryActive = false;
let backupImportBound = false;
let adminToolsBound = false;
let activeUserId = null;
let accessCheckTimer = null;
let accessCheckBusy = false;

const ADMIN_FIELDS = ['partners', 'referrals', 'financeRecords', 'fixedCosts'];
const TEAM_FIELDS = ['quote', 'savedQuotes', 'plan', 'visit', 'savedVisits', 'receipt', 'receipts', 'execution', 'savedExecutions'];
function copy(value) { return JSON.parse(JSON.stringify(value ?? {})); }
function teamSafeState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const data = Object.fromEntries(TEAM_FIELDS.filter(field => Object.hasOwn(source, field)).map(field => [field, copy(source[field])]));
  const stripQuoteCosts = quote => {
    if (!quote || typeof quote !== 'object') return quote;
    quote.items = Array.isArray(quote.items) ? quote.items.map(item => {
      const safe = { ...item }; delete safe.cost; return safe;
    }) : [];
    return quote;
  };
  data.quote = stripQuoteCosts(data.quote);
  data.savedQuotes = Array.isArray(data.savedQuotes) ? data.savedQuotes.map(row => ({
    ...row, q: stripQuoteCosts(copy(row?.q))
  })) : [];
  return data;
}
function hasPrivateData(value) {
  if (!value || typeof value !== 'object') return false;
  if ((value.partners || []).length || (value.referrals || []).length) return true;
  const hasEnteredValues = (records, ignored = []) => Object.values(records || {}).some(record =>
    Object.entries(record || {}).some(([key, item]) => !ignored.includes(key) && item !== '' && item != null)
  );
  if (hasEnteredValues(value.financeRecords, ['status', 'month']) ||
      hasEnteredValues(value.fixedCosts, ['allocation'])) return true;
  const hasItemCost = quote => (quote?.items || []).some(item => item?.cost !== '' && item?.cost != null);
  return hasItemCost(value.quote) || (value.savedQuotes || []).some(row => hasItemCost(row?.q));
}
function restoreQuoteCosts(teamQuote, adminQuote) {
  const quote = copy(teamQuote);
  const privateItems = Array.isArray(adminQuote?.items) ? adminQuote.items : [];
  const costsById = new Map(privateItems.map((item, index) => [String(item.id ?? index), item.cost]));
  quote.items = (Array.isArray(quote.items) ? quote.items : []).map((item, index) => {
    const key = String(item.id ?? index);
    return costsById.has(key) ? { ...item, cost: costsById.get(key) } : item;
  });
  return quote;
}
function combineAdminAndTeam(adminData, teamData) {
  const combined = { ...copy(adminData), ...copy(teamData) };
  combined.quote = restoreQuoteCosts(teamData.quote, adminData.quote);
  const privateQuotes = new Map((adminData.savedQuotes || []).map(row => [String(row.id), row]));
  combined.savedQuotes = (teamData.savedQuotes || []).map(row => {
    const privateRow = privateQuotes.get(String(row.id));
    return { ...row, q: restoreQuoteCosts(row.q, privateRow?.q) };
  });
  for (const field of ADMIN_FIELDS) combined[field] = copy(adminData[field]);
  return combined;
}
function setMemberRole(role) {
  memberRole = role;
  window.__CP_MEMBER_ROLE = role;
  window.__cpSetAccessRole?.(role);
}
async function initializeState(data) {
  const { data: adminRow, error: adminError } = await supabase.from('internal_app_state')
    .insert({ id: 'connectplus', data, revision: 1 }).select('revision').single();
  if (adminError) throw adminError;
  currentRevision = adminRow.revision;
  if (splitStorage) {
    const { data: teamRow, error: teamError } = await supabase.from('team_app_state')
      .insert({ id: 'connectplus', data: teamSafeState(data), revision: 1 }).select('revision').single();
    if (teamError) throw teamError;
    teamRevision = teamRow.revision;
  }
}
async function saveCloudState(stateObj) {
  if (memberRole === 'technician') {
    const { data, error } = await supabase.rpc('save_team_app_state', {
      p_data: teamSafeState(stateObj),
      p_revision: teamRevision
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    if (!result?.team_revision) throw new Error('Os dados da equipe mudaram em outra sessão. Atualize a plataforma.');
    teamRevision = result.team_revision;
    return;
  }
  if (splitStorage) {
    const { data, error } = await supabase.rpc('save_company_app_state', {
      p_admin_data: stateObj,
      p_team_data: teamSafeState(stateObj),
      p_admin_revision: currentRevision,
      p_team_revision: teamRevision
    });
    if (error) throw error;
    const revisions = Array.isArray(data) ? data[0] : data;
    if (!revisions) throw new Error('O banco não confirmou a sincronização das duas áreas.');
    currentRevision = revisions.admin_revision;
    teamRevision = revisions.team_revision;
    return;
  }
  const { data, error } = await supabase.from('internal_app_state')
    .update({ data: stateObj, revision: currentRevision + 1, updated_at: new Date().toISOString() })
    .eq('id', 'connectplus').eq('revision', currentRevision).select('revision').maybeSingle();
  if (error || !data) throw error || new Error('Os dados online mudaram em outra sessão. Atualize a plataforma.');
  currentRevision = data.revision;
}

function say(text, error = false) {
  msg.textContent = text;
  msg.dataset.error = error ? 'true' : 'false';
}
function bindBackupImport() {
  if (backupImportBound) return;
  const input = document.getElementById('backupFileInput');
  if (!input) return;
  backupImportBound = true;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error('O arquivo de backup excede o limite de 15 MB.');
      const backup = JSON.parse(await file.text());
      const isPlatformBackup = backup?.app === 'ConnectPlus Plataforma' && backup?.formatVersion === 1;
      const isLegacyBackup = backup?.product === 'Connect Plus Gestão';
      const data = backup?.data;
      if ((!isPlatformBackup && !isLegacyBackup) || !data || typeof data !== 'object' || Array.isArray(data) ||
          !data.quote || typeof data.quote !== 'object' || !data.plan || typeof data.plan !== 'object' || !Array.isArray(data.savedQuotes)) {
        throw new Error('Este arquivo não parece ser um backup válido da Connect Plus.');
      }
      if (!confirm('O backup será enviado para a nuvem segura da Connect Plus e ficará disponível nesta plataforma. Deseja continuar?')) return;
      say('Enviando o backup para a nuvem segura…');
      const { data: saved, error } = await supabase.from('internal_app_state')
        .insert({ id: 'connectplus', data, revision: 1 }).select('revision').single();
      if (error?.code === '23505') {
        const { data: cloudState, error: readError } = await supabase.from('internal_app_state')
          .select('data,revision').eq('id', 'connectplus').maybeSingle();
        if (readError) throw readError;
        if (!cloudState) throw error;
        localStorage.setItem(recoveryKey, JSON.stringify({ savedAt: new Date().toISOString(), data }));
        askResolveConflict(data, cloudState);
        say('Já existe uma versão na nuvem. Baixe uma cópia local e escolha qual versão manter.');
        return;
      }
      if (error) throw error;
      currentRevision = saved.revision;
      if (splitStorage) {
        const { data: teamRow, error: teamError } = await supabase.from('team_app_state')
          .insert({ id: 'connectplus', data: teamSafeState(data), revision: 1 }).select('revision').single();
        if (teamError) throw teamError;
        teamRevision = teamRow.revision;
      }
      localStorage.setItem(localKey, JSON.stringify(data));
      localStorage.setItem(recoveryKey, JSON.stringify({ savedAt: new Date().toISOString(), data }));
      sessionStorage.setItem('cp-cloud-state-loaded', '1');
      sessionStorage.setItem('cp-allow-hydrate', '1');
      say('Backup importado. Abrindo a plataforma…');
      location.reload();
    } catch (e) {
      say(`Não foi possível restaurar o backup: ${e.message || String(e)}`, true);
    } finally {
      input.value = '';
    }
  });
}
function showGate() { gate.hidden = false; app.hidden = true; }
function showApp() {
  gate.hidden = true;
  app.hidden = false;
  document.getElementById('cloudBadge').hidden = false;
  sessionStorage.removeItem('cp-cloud-state-loaded');
  sessionStorage.removeItem('cp-allow-hydrate');
  if (['owner', 'admin'].includes(memberRole)) initializeAdminTools();
  startAccessRevalidation();
}

async function revalidateAccess() {
  if (!activeUserId || accessCheckBusy || passwordRecoveryActive || !supabase) return;
  accessCheckBusy = true;
  try {
    const { data, error } = await supabase.from('company_members')
      .select('role,active').eq('user_id', activeUserId).maybeSingle();
    if (error) return;
    if (!data?.active || !['owner', 'admin', 'technician'].includes(data.role)) {
      await supabase.auth.signOut();
      localStorage.removeItem(localKey);
      localStorage.removeItem(recoveryKey);
      location.reload();
      return;
    }
    if (data.role !== memberRole) {
      setMemberRole(data.role);
      await loadSecureState();
    }
  } catch {
    // Keep the current view during a temporary network outage. Access is checked
    // again when the connection returns or the window becomes active.
  } finally {
    accessCheckBusy = false;
  }
}

function startAccessRevalidation() {
  if (accessCheckTimer) clearInterval(accessCheckTimer);
  accessCheckTimer = setInterval(revalidateAccess, 45000);
}

window.addEventListener('focus', revalidateAccess);

function setAdminStatus(id, text, error = false) {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = text;
  element.dataset.error = error ? 'true' : 'false';
}

function renderCompanyMembers(rows) {
  const list = document.getElementById('companyMemberList');
  if (!list) return;
  list.replaceChildren();
  if (!rows?.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Nenhum acesso da equipe foi cadastrado ainda.';
    list.append(empty);
    return;
  }
  for (const member of rows) {
    const row = document.createElement('div');
    row.className = 'saved-row';
    const details = document.createElement('div');
    const email = document.createElement('strong');
    email.textContent = member.email || 'Conta sem e-mail';
    const status = document.createElement('span');
    const roleLabel = member.role === 'owner' ? 'Proprietário' : member.role === 'admin' ? 'Administrador' : 'Técnico';
    status.textContent = `${roleLabel} · ${member.active ? 'Ativo' : 'Desativado'}`;
    details.append(email, document.createElement('br'), status);
    row.append(details);
    if (member.active && member.role !== 'owner' && member.email?.toLowerCase() !== document.getElementById('cloudAccount')?.textContent?.toLowerCase()) {
      const disable = document.createElement('button');
      disable.type = 'button';
      disable.className = 'button danger';
      disable.textContent = 'Desativar';
      disable.addEventListener('click', () => changeMemberStatus(member, false));
      row.append(disable);
    } else if (!member.active && member.role !== 'owner') {
      const enable = document.createElement('button');
      enable.type = 'button';
      enable.className = 'button secondary';
      enable.textContent = 'Reativar';
      enable.addEventListener('click', () => changeMemberStatus(member, true));
      row.append(enable);
    }
    list.append(row);
  }
}

async function loadCompanyMembers() {
  setAdminStatus('companyMemberStatus', 'Carregando acessos…');
  const { data, error } = await supabase.from('company_members')
    .select('user_id,email,role,active,created_at').order('created_at', { ascending: true });
  if (error) throw error;
  renderCompanyMembers(data || []);
  setAdminStatus('companyMemberStatus', `${data?.length || 0} acesso(s) cadastrado(s).`);
}

async function changeMemberStatus(member, active) {
  if (!confirm(`${active ? 'Reativar' : 'Desativar'} o acesso de ${member.email}?`)) return;
  setAdminStatus('companyMemberStatus', 'Atualizando acesso…');
  const { error } = await supabase.rpc('manage_company_member_access', {
    p_email: member.email,
    p_role: member.role,
    p_active: active
  });
  if (error) return setAdminStatus('companyMemberStatus', error.message || 'Não foi possível atualizar o acesso.', true);
  try { await loadCompanyMembers(); }
  catch (loadError) { setAdminStatus('companyMemberStatus', loadError.message || 'Acesso atualizado, mas não foi possível recarregar a lista.', true); }
}

function renderCompanyHistory(rows) {
  const list = document.getElementById('companyHistoryList');
  if (!list) return;
  list.replaceChildren();
  if (!rows?.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'O histórico será criado após as próximas alterações sincronizadas.';
    list.append(empty);
    return;
  }
  for (const entry of rows) {
    const row = document.createElement('div');
    row.className = 'saved-row';
    const details = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = entry.area === 'admin' ? 'Área administrativa' : 'Área da equipe';
    const metadata = document.createElement('span');
    const timestamp = entry.changed_at ? new Date(entry.changed_at).toLocaleString('pt-BR') : 'Data indisponível';
    metadata.textContent = `${timestamp} · ${entry.actor_email || 'Conta autorizada'} · versão anterior ${entry.from_revision}`;
    details.append(label, document.createElement('br'), metadata);
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'button secondary';
    restore.textContent = 'Restaurar esta versão';
    restore.addEventListener('click', () => restoreCompanyHistory(entry));
    row.append(details, restore);
    list.append(row);
  }
}

async function loadCompanyHistory() {
  setAdminStatus('companyHistoryStatus', 'Carregando histórico…');
  const { data, error } = await supabase.from('company_app_state_audit')
    .select('id,area,actor_email,changed_at,from_revision,to_revision')
    .order('id', { ascending: false }).limit(20);
  if (error) throw error;
  renderCompanyHistory(data || []);
  setAdminStatus('companyHistoryStatus', `${data?.length || 0} versão(ões) de recuperação disponíveis.`);
}

async function restoreCompanyHistory(entry) {
  const area = entry.area === 'admin' ? 'administrativa' : 'equipe';
  if (!confirm(`Restaurar a versão anterior ${entry.from_revision} da ${area}? O estado atual será guardado no histórico.`)) return;
  setAdminStatus('companyHistoryStatus', 'Restaurando os dados…');
  const { error } = await supabase.rpc('restore_company_state_audit', { p_audit_id: entry.id });
  if (error) return setAdminStatus('companyHistoryStatus', error.message || 'Não foi possível restaurar esta versão.', true);
  try {
    const current = localStorage.getItem(localKey);
    if (current) localStorage.setItem(recoveryKey, JSON.stringify({ savedAt: new Date().toISOString(), data: JSON.parse(current) }));
  } catch {}
  sessionStorage.setItem('cp-cloud-state-loaded', '1');
  sessionStorage.setItem('cp-allow-hydrate', '1');
  location.reload();
}

function initializeAdminTools() {
  if (adminToolsBound) return;
  adminToolsBound = true;
  const roleOption = document.getElementById('memberAdminRoleOption');
  if (roleOption) roleOption.hidden = memberRole !== 'owner';
  const form = document.getElementById('companyMemberForm');
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const email = document.getElementById('companyMemberEmail').value.trim().toLowerCase();
    const role = document.getElementById('companyMemberRole').value;
    if (!email) return setAdminStatus('companyMemberStatus', 'Informe o e-mail da conta já criada no Supabase.', true);
    setAdminStatus('companyMemberStatus', 'Salvando acesso…');
    const { error } = await supabase.rpc('manage_company_member_access', {
      p_email: email, p_role: role, p_active: true
    });
    if (error) return setAdminStatus('companyMemberStatus', error.message || 'Não foi possível salvar o acesso.', true);
    form.reset();
    try { await loadCompanyMembers(); }
    catch (loadError) { setAdminStatus('companyMemberStatus', loadError.message || 'Acesso salvo, mas a lista não foi atualizada.', true); }
  });
  document.getElementById('refreshCompanyMembers')?.addEventListener('click', () => loadCompanyMembers().catch(error => setAdminStatus('companyMemberStatus', error.message || 'Falha ao carregar os acessos.', true)));
  document.getElementById('refreshCompanyHistory')?.addEventListener('click', () => loadCompanyHistory().catch(error => setAdminStatus('companyHistoryStatus', error.message || 'Falha ao carregar o histórico.', true)));
  Promise.all([loadCompanyMembers(), loadCompanyHistory()]).catch(error => {
    setAdminStatus('companyMemberStatus', error.message || 'Não foi possível carregar os controles administrativos.', true);
  });
}
function parseLocal() {
  try {
    const current = JSON.parse(localStorage.getItem(localKey) || 'null');
    if (current) return current;
  } catch {}
  try { const recovery = JSON.parse(localStorage.getItem(recoveryKey) || 'null'); return recovery?.data || null; } catch { return null; }
}
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function downloadLocalBackup() {
  const content = JSON.stringify({ product: 'Connect Plus Gestão', exportedAt: new Date().toISOString(), data: parseLocal() || {} }, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  a.download = `ConnectPlus_backup_local_${new Date().toISOString().slice(0,10)}.json`;
  const url = a.href; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function showMigrationPanel() {
  document.getElementById('loginForm').hidden = true;
  document.getElementById('forgotPassword').hidden = true;
  document.getElementById('resetPasswordForm').hidden = true;
}
function askImport(localData) {
  showMigrationPanel();
  bindBackupImport();
  const box = document.getElementById('importChoice');
  box.hidden = false;
  say('Selecione o arquivo de backup JSON para continuar.');
  document.getElementById('downloadLocalBackup').onclick = () => {
    downloadLocalBackup();
    document.getElementById('importLocalData').disabled = false;
    say('Backup baixado. Agora você pode importar os dados deste notebook com segurança.');
  };
  document.getElementById('importLocalData').onclick = async () => {
    if (!localData) return say('Não há dados locais para importar.', true);
    try {
      say('Enviando os dados para a área interna segura…');
      await initializeState(localData);
      localStorage.setItem(localKey, JSON.stringify(localData));
      sessionStorage.setItem('cp-cloud-state-loaded', '1'); sessionStorage.setItem('cp-allow-hydrate', '1');
      location.reload();
    } catch (e) { say(`Não foi possível importar: ${e.message}`, true); }
  };
  document.getElementById('startEmpty').onclick = async () => {
    try {
      const empty = { quote: { items: [] }, savedQuotes: [], plan: { rooms: [] } };
      await initializeState(empty);
      localStorage.setItem(localKey, JSON.stringify(empty));
      sessionStorage.setItem('cp-cloud-state-loaded', '1'); sessionStorage.setItem('cp-allow-hydrate', '1');
      location.reload();
    } catch (e) { say(`Não foi possível iniciar: ${e.message}`, true); }
  };
}

function askResolveConflict(localData, cloudState) {
  showMigrationPanel();
  bindBackupImport();
  const box = document.getElementById('importChoice');
  box.hidden = false;
  say('Escolha qual versão manter ou selecione um backup JSON.');
  const importTitle = document.getElementById('importTitle');
  if (importTitle) importTitle.textContent = 'Há dados diferentes neste notebook';
  const importDescription = document.getElementById('importDescription');
  if (importDescription) importDescription.textContent = 'Antes de escolher, baixe uma cópia local. Depois decida se mantém a versão da nuvem ou envia a versão deste notebook.';
  document.getElementById('startEmpty').hidden = true;
  document.getElementById('downloadLocalBackup').onclick = () => {
    downloadLocalBackup();
    document.getElementById('importLocalData').disabled = false;
    document.getElementById('keepCloudData').disabled = false;
    say('Backup local baixado. Agora escolha qual versão deseja manter.');
  };
  document.getElementById('importLocalData').textContent = '2. Enviar dados deste notebook para a nuvem';
  document.getElementById('importLocalData').onclick = async () => {
    try {
      say('Atualizando os dados online…');
      if (splitStorage) {
        await saveCloudState(localData);
      } else {
        const { data, error } = await supabase.from('internal_app_state').update({ data: localData, revision: cloudState.revision + 1, updated_at: new Date().toISOString() }).eq('id','connectplus').eq('revision',cloudState.revision).select('revision').maybeSingle();
        if (error || !data) throw error || new Error('Os dados online mudaram durante esta ação. Atualize a página e confira novamente.');
        currentRevision = data.revision;
      }
      localStorage.setItem(localKey, JSON.stringify(localData));
      sessionStorage.setItem('cp-cloud-state-loaded', '1'); sessionStorage.setItem('cp-allow-hydrate', '1');
      location.reload();
    } catch (e) { say(`Não foi possível sincronizar: ${e.message}`, true); }
  };
  document.getElementById('keepCloudData').onclick = () => {
    localStorage.setItem(recoveryKey, JSON.stringify({ savedAt: new Date().toISOString(), data: localData }));
    localStorage.setItem(localKey, JSON.stringify(cloudState.data));
    sessionStorage.setItem('cp-cloud-state-loaded', '1'); sessionStorage.setItem('cp-allow-hydrate', '1');
    location.reload();
  };
}

async function loadSecureState() {
  if (passwordRecoveryActive || loadingState) return;
  loadingState = true;
  try {
  say('Verificando sua conta e carregando os dados…');
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (passwordRecoveryActive) return;
  if (userError || !userData.user) return showGate();
  activeUserId = userData.user.id;
  const { data: member, error: memberError } = await supabase.from('company_members')
    .select('role,active').eq('user_id', userData.user.id).maybeSingle();
  if (passwordRecoveryActive) return;
  if (memberError || !member?.active || !['owner', 'admin', 'technician'].includes(member.role)) {
    await supabase.auth.signOut();
    showGate();
    return say('Esta conta não tem acesso autorizado à plataforma interna. Peça ao administrador para liberar o usuário.', true);
  }
  setMemberRole(member.role);

  let remoteData;
  if (member.role === 'technician') {
    const { data: teamState, error: teamError } = await supabase.from('team_app_state')
      .select('data,revision').eq('id', 'connectplus').maybeSingle();
    if (passwordRecoveryActive) return;
    if (teamError || !teamState) {
      showGate();
      return say('O acesso técnico ainda não foi preparado no banco seguro. Peça ao administrador para concluir a configuração antes de liberar esta conta.', true);
    }
    splitStorage = true;
    teamRevision = teamState.revision;
    remoteData = teamSafeState(teamState.data);
  } else {
    const { data: adminState, error: adminError } = await supabase.from('internal_app_state')
      .select('data,revision').eq('id', 'connectplus').maybeSingle();
    if (passwordRecoveryActive) return;
    if (adminError) {
      showGate();
      return say('Não foi possível carregar os dados administrativos. Confira as permissões e a conexão do projeto seguro.', true);
    }
    if (!adminState) {
      const { error: schemaError } = await supabase.from('team_app_state')
        .select('id').eq('id', 'connectplus').maybeSingle();
      if (schemaError && ['42P01', 'PGRST205'].includes(schemaError.code)) splitStorage = false;
      else if (schemaError) {
        showGate();
        return say('Não foi possível verificar a configuração segura da equipe.', true);
      } else splitStorage = true;
      showGate();
      return askImport(parseLocal());
    }
    currentRevision = adminState.revision;
    const { data: teamState, error: teamError } = await supabase.from('team_app_state')
      .select('data,revision').eq('id', 'connectplus').maybeSingle();
    if (teamError && ['42P01', 'PGRST205'].includes(teamError.code)) {
      // Safe compatibility for administrators until the database migration runs.
      splitStorage = false;
      remoteData = adminState.data;
    } else if (teamError) {
      showGate();
      return say('Não foi possível carregar os dados da equipe. Atualize a página e tente novamente.', true);
    } else {
      splitStorage = true;
      if (!teamState) {
        const { data: seeded, error: seedError } = await supabase.from('team_app_state')
          .insert({ id: 'connectplus', data: teamSafeState(adminState.data), revision: 1 })
          .select('data,revision').single();
        if (seedError) {
          showGate();
          return say('Não foi possível preparar a área da equipe. Os dados administrativos continuam preservados; tente novamente ou peça suporte.', true);
        }
        teamRevision = seeded.revision;
        remoteData = combineAdminAndTeam(adminState.data, seeded.data);
      } else {
        teamRevision = teamState.revision;
        remoteData = combineAdminAndTeam(adminState.data, teamState.data);
      }
    }
  }

  const localData = member.role === 'technician' ? null : parseLocal();
  const localMatchesRemote = stableStringify(localData) === stableStringify(remoteData);
  const localMatchesTeamOnly = member.role !== 'technician' && splitStorage && localData &&
    !hasPrivateData(localData) &&
    stableStringify(teamSafeState(localData)) === stableStringify(teamSafeState(remoteData));
  if (member.role === 'technician' || !localMatchesRemote) {
    if (localData && member.role !== 'technician' && !localMatchesTeamOnly && !sessionStorage.getItem('cp-cloud-state-loaded')) {
      showGate();
      return askResolveConflict(localData, { revision: currentRevision, data: remoteData });
    }
    localStorage.setItem(localKey, JSON.stringify(remoteData));
    localStorage.setItem(recoveryKey, JSON.stringify({ savedAt: new Date().toISOString(), data: remoteData }));
    if (!sessionStorage.getItem('cp-cloud-state-loaded')) {
      sessionStorage.setItem('cp-cloud-state-loaded', '1');
      sessionStorage.setItem('cp-allow-hydrate', '1');
      location.reload();
      return;
    }
  }
  if (!sessionStorage.getItem('cp-allow-hydrate')) {
    sessionStorage.setItem('cp-allow-hydrate', '1');
    location.reload();
    return;
  }
  window.__queueCloudSave = (stateObj) => {
    pendingState = JSON.parse(JSON.stringify(stateObj));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveChain = saveChain.then(async () => {
        if (!pendingState) return;
        const payload = pendingState; pendingState = null;
        await saveCloudState(payload);
        document.getElementById('quoteStatus').textContent = 'Salvo neste navegador e sincronizado com segurança.';
      }).catch(e => {
        document.getElementById('quoteStatus').textContent = `A sincronização online falhou: ${e.message || 'atualize a plataforma e tente novamente.'}`;
        console.error('Falha na sincronização:', e);
      });
    }, 700);
  };
  document.getElementById('cloudAccount').textContent = userData.user.email || 'Conta autorizada';
  document.getElementById('cloudSignOut').onclick = async () => { await supabase.auth.signOut(); location.reload(); };
  if (passwordRecoveryActive) return;
  showApp();
  } finally { loadingState = false; }
}

document.getElementById('forgotPassword').addEventListener('click', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  if (!email) return say('Digite seu e-mail para receber o link de redefinição.', true);
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('?')[0] });
  say(error ? `Não foi possível enviar: ${error.message}` : 'Se esse e-mail estiver cadastrado, você receberá instruções para redefinir a senha.', !!error);
});
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  say('Entrando…');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return say('Não foi possível entrar. Confira o e-mail e a senha, ou confirme se o administrador liberou esta conta.', true);
  await loadSecureState();
});

if (!cfg.url || cfg.url.includes('COLE_') || !cfg.publishableKey || cfg.publishableKey.includes('COLE_')) {
  form.querySelectorAll('input,button').forEach(el => { el.disabled = true; });
  document.getElementById('forgotPassword').disabled = true;
  showGate(); say('A conexão segura ainda precisa ser configurada com o projeto Supabase exclusivo da plataforma interna.', true);
} else {
  supabase = createClient(cfg.url, cfg.publishableKey);
  // Expose only the active staff session token to the portal bridge. The portal
  // Edge Function independently verifies this token and the owner/admin role.
  window.__getInternalAccessToken = async () => {
    if (!['owner', 'admin'].includes(memberRole)) throw new Error('Somente administradores podem gerenciar o portal do cliente.');
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session?.access_token || null;
  };
  // The support queue sends this same staff JWT to its own server-side role check.
  // It does not grant a technician access to proposal publishing or document management.
  window.__getTeamSupportAccessToken = async () => {
    if (!['owner', 'admin', 'technician'].includes(memberRole)) throw new Error('Somente membros ativos da equipe podem acessar o suporte.');
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session?.access_token || null;
  };
  showGate();
  supabase.auth.getSession().then(({ data }) => data.session ? loadSecureState() : say('Entre com a conta da equipe autorizada.'));
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      passwordRecoveryActive = true;
      showGate();
      document.getElementById('loginForm').hidden = true;
      document.getElementById('forgotPassword').hidden = true;
      document.getElementById('resetPasswordForm').hidden = false;
      say('Crie uma nova senha para sua conta.');
      return;
    }
    if (session && app.hidden) setTimeout(loadSecureState, 0);
  });
}

document.getElementById('resetPasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('newPassword').value;
  if (password.length < 10) return say('Use uma senha com pelo menos 10 caracteres.', true);
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return say(`Não foi possível atualizar a senha: ${error.message}`, true);
  passwordRecoveryActive = false;
  document.getElementById('resetPasswordForm').hidden = true;
  document.getElementById('loginForm').hidden = false;
  document.getElementById('forgotPassword').hidden = false;
  say('Senha atualizada. Entrando na plataforma…');
  await loadSecureState();
});
