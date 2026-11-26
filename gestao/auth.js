import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cfg = window.CONNECTPLUS_SUPABASE || {};
const gate = document.getElementById('secureGate');
const app = document.getElementById('appRoot');
const msg = document.getElementById('gateMessage');
const form = document.getElementById('loginForm');
const localKey = 'connectplus-platform-v1';
const recoveryKey = 'connectplus-platform-v1-recovery';
let supabase, currentRevision = null, pendingState = null, saveTimer = null, saveChain = Promise.resolve();
let loadingState = false;
let passwordRecoveryActive = false;
let backupImportBound = false;

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
      if (error) throw error;
      currentRevision = saved.revision;
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
      const { data, error } = await supabase.from('internal_app_state').insert({ id: 'connectplus', data: localData, revision: 1 }).select('revision').single();
      if (error) throw error;
      currentRevision = data.revision;
      localStorage.setItem(localKey, JSON.stringify(localData));
      sessionStorage.setItem('cp-cloud-state-loaded', '1'); sessionStorage.setItem('cp-allow-hydrate', '1');
      location.reload();
    } catch (e) { say(`Não foi possível importar: ${e.message}`, true); }
  };
  document.getElementById('startEmpty').onclick = async () => {
    try {
      const empty = { quote: { items: [] }, savedQuotes: [], plan: { rooms: [] } };
      const { data, error } = await supabase.from('internal_app_state').insert({ id: 'connectplus', data: empty, revision: 1 }).select('revision').single();
      if (error) throw error;
      currentRevision = data.revision;
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
  document.getElementById('importTitle').textContent = 'Há dados diferentes neste notebook';
  document.getElementById('importDescription').textContent = 'Antes de escolher, baixe uma cópia local. Depois decida se mantém a versão da nuvem ou envia a versão deste notebook.';
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
      const { data, error } = await supabase.from('internal_app_state').update({ data: localData, revision: cloudState.revision + 1, updated_at: new Date().toISOString() }).eq('id','connectplus').eq('revision',cloudState.revision).select('revision').maybeSingle();
      if (error || !data) throw error || new Error('Os dados online mudaram durante esta ação. Atualize a página e confira novamente.');
      currentRevision = data.revision;
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
  const { data: member, error: memberError } = await supabase.from('company_members').select('role,active').eq('user_id', userData.user.id).maybeSingle();
  if (passwordRecoveryActive) return;
  if (memberError || !member?.active || !['owner','admin'].includes(member.role)) {
    await supabase.auth.signOut();
    showGate();
    return say('Esta conta não tem acesso autorizado à plataforma interna. Peça ao administrador para liberar o usuário.', true);
  }
  const { data: state, error } = await supabase.from('internal_app_state').select('data,revision').eq('id','connectplus').maybeSingle();
  if (passwordRecoveryActive) return;
  if (error) {
    showGate();
    return say('Não foi possível carregar os dados. Confira se o projeto interno e as permissões foram configurados.', true);
  }
  if (!state) {
    showGate();
    return askImport(parseLocal());
  }
  currentRevision = state.revision;
  const remoteJSON = JSON.stringify(state.data);
  const localData = parseLocal();
  if (stableStringify(localData) !== stableStringify(state.data)) {
    if (localData && !sessionStorage.getItem('cp-cloud-state-loaded')) {
      showGate();
      return askResolveConflict(localData, state);
    }
    localStorage.setItem(localKey, remoteJSON);
    localStorage.setItem(recoveryKey, JSON.stringify({ savedAt: new Date().toISOString(), data: state.data }));
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
        const expected = currentRevision;
        const { data, error: saveError } = await supabase.from('internal_app_state')
          .update({ data: payload, revision: expected + 1, updated_at: new Date().toISOString() })
          .eq('id','connectplus').eq('revision',expected).select('revision').maybeSingle();
        if (saveError || !data) {
          document.getElementById('quoteStatus').textContent = 'A sincronização online falhou ou houve alteração simultânea. Baixe um backup e atualize os dados antes de continuar.';
          console.error(saveError || 'Conflito de revisão');
          return;
        }
        currentRevision = data.revision;
        document.getElementById('quoteStatus').textContent = 'Salvo neste navegador e sincronizado com segurança.';
      }).catch(e => console.error('Falha na sincronização:', e));
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
