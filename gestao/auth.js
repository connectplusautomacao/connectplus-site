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

const ADMIN_FIELDS = ['partners', 'referrals', 'financeRecords', 'fixedCosts'];
function copy(value) { return JSON.parse(JSON.stringify(value ?? {})); }
function teamSafeState(value) {
  const data = copy(value);
  for (const field of ADMIN_FIELDS) delete data[field];
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
    const { data, error } = await supabase.from('team_app_state')
      .update({ data: teamSafeState(stateObj), revision: teamRevision + 1, updated_at: new Date().toISOString() })
      .eq('id', 'connectplus').eq('revision', teamRevision).select('revision').maybeSingle();
    if (error || !data) throw error || new Error('Os dados da equipe mudaram em outra sessão. Atualize a plataforma.');
    teamRevision = data.revision;
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
function showApp() { gate.hidden = true; app.hidden = false; document.getElementById('cloudBadge').hidden = false; sessionStorage.removeItem('cp-cloud-state-loaded'); sessionStorage.removeItem('cp-allow-hydrate'); }
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
