/* Public portal client. Only a Supabase publishable key belongs here after setup.
   Never put a service_role/secret key in this file. */
const SUPABASE_URL = 'https://pseknwikhzfkqqgnevwt.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Pf3siffzkKJ90W2nm_FB4g_he7887XY';
const BUCKET = 'client-documents';

const $ = (id) => document.getElementById(id);
const loginCard = $('loginCard');
const resetCard = $('resetCard');
const dashboard = $('dashboard');
const configWarning = $('configWarning');
let client = null;

function setMessage(id, message, isError = false) {
  const el = $(id);
  el.textContent = message;
  el.classList.toggle('error', isError);
}

function configured() {
  return Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY && window.supabase?.createClient);
}

function showLogin() {
  loginCard.classList.remove('hidden');
  resetCard.classList.add('hidden');
  dashboard.classList.add('hidden');
}

function showDashboard(email) {
  loginCard.classList.add('hidden');
  resetCard.classList.add('hidden');
  dashboard.classList.remove('hidden');
  $('userEmail').textContent = email || '';
}

function formatDate(value) {
  if (!value) return 'A combinar';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.valueOf()) ? 'A combinar' : date.toLocaleDateString('pt-BR');
}

function addEmpty(container, message) {
  const box = document.createElement('div');
  box.className = 'empty';
  box.textContent = message;
  container.append(box);
}

function renderProject(project, updates, documents) {
  const node = $('projectTemplate').content.firstElementChild.cloneNode(true);
  node.querySelector('[data-field="code"]').textContent = project.code;
  node.querySelector('[data-field="title"]').textContent = project.title;
  node.querySelector('[data-field="status"]').textContent = project.status;
  const pct = Math.min(100, Math.max(0, Number(project.progress) || 0));
  node.querySelector('[data-field="progress"]').textContent = `${pct}%`;
  node.querySelector('[data-field="progressBar"]').style.width = `${pct}%`;
  node.querySelector('[data-field="nextStep"]').textContent = project.next_step || 'A equipe atualizará em breve';
  node.querySelector('[data-field="expectedDate"]').textContent = formatDate(project.expected_date);

  const updatesBox = node.querySelector('[data-field="updates"]');
  if (!updates.length) addEmpty(updatesBox, 'Nenhuma atualização publicada até o momento.');
  for (const update of updates) {
    const item = $('updateTemplate').content.firstElementChild.cloneNode(true);
    item.querySelector('[data-field="title"]').textContent = update.title;
    item.querySelector('[data-field="message"]').textContent = update.message;
    item.querySelector('[data-field="date"]').textContent = formatDate(update.created_at?.slice(0, 10));
    updatesBox.append(item);
  }

  const docsBox = node.querySelector('[data-field="documents"]');
  if (!documents.length) addEmpty(docsBox, 'Nenhum documento foi liberado para consulta.');
  for (const doc of documents) {
    const row = document.createElement('div');
    row.className = 'document';
    const name = document.createElement('span');
    name.textContent = doc.title;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button secondary';
    button.textContent = 'Baixar documento';
    button.addEventListener('click', () => downloadDocument(doc, button));
    row.append(name, button);
    docsBox.append(row);
  }
  $('projectList').append(node);
}

async function downloadDocument(doc, button) {
  button.disabled = true;
  button.textContent = 'Verificando acesso…';
  try {
    const { data, error } = await client.storage.from(BUCKET).download(doc.storage_path);
    if (error) throw error;
    const url = URL.createObjectURL(data);
    const link = document.createElement('a');
    link.href = url;
    link.download = doc.file_name || doc.title || 'documento';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    showError('Não foi possível baixar este documento. Confira sua conexão ou fale com a Connect Plus.');
  } finally {
    button.disabled = false;
    button.textContent = 'Baixar documento';
  }
}

async function loadProjects(user) {
  $('projectList').replaceChildren();
  $('welcome').textContent = 'Projetos liberados para você';
  const { data: memberships, error: membershipError } = await client
    .from('project_members')
    .select('project_id, projects!inner(id, code, title, status, progress, next_step, expected_date)')
    .eq('user_id', user.id);
  if (membershipError) throw membershipError;
  const projects = (memberships || []).map((m) => m.projects).filter(Boolean);
  if (!projects.length) {
    addEmpty($('projectList'), 'Nenhum projeto foi liberado para esta conta. Se precisar de ajuda, fale com a Connect Plus.');
    return;
  }
  for (const project of projects) {
    const [{ data: updates, error: updatesError }, { data: docs, error: docsError }] = await Promise.all([
      client.from('project_updates').select('title, message, created_at').eq('project_id', project.id).eq('visible_to_client', true).order('created_at', { ascending: false }),
      client.from('project_documents').select('title, file_name, storage_path').eq('project_id', project.id).eq('visible_to_client', true).order('created_at', { ascending: false }),
    ]);
    if (updatesError || docsError) throw updatesError || docsError;
    renderProject(project, updates || [], docs || []);
  }
}

function showError(message) {
  $('errorText').textContent = message;
  $('errorDialog').showModal();
}

async function refreshSession() {
  if (!configured()) return;
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) {
    showLogin();
    return;
  }
  try {
    showDashboard(data.session.user.email);
    await loadProjects(data.session.user);
  } catch {
    showLogin();
    setMessage('loginMessage', 'Não foi possível carregar seus projetos. Tente novamente.', true);
  }
}

async function init() {
  const params = new URLSearchParams(location.search);
  const isRecoveryFlow = params.get('flow') === 'password-recovery' || location.hash.includes('type=recovery');
  if (isRecoveryFlow) {
    loginCard.classList.add('hidden');
    resetCard.classList.remove('hidden');
  }
  if (!configured()) {
    configWarning.classList.remove('hidden');
    $('loginButton').disabled = true;
    $('forgotPassword').disabled = true;
    setMessage('loginMessage', 'O portal está protegido e aguarda a configuração do serviço de acesso.');
    return;
  }
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
  });
  if (!isRecoveryFlow) await refreshSession();
  client.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') showLogin();
    if (event === 'SIGNED_IN' && session) setTimeout(() => refreshSession(), 0);
    if (event === 'PASSWORD_RECOVERY') {
      loginCard.classList.add('hidden');
      dashboard.classList.add('hidden');
      resetCard.classList.remove('hidden');
    }
  });
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!configured() || !client) return;
  const button = $('loginButton');
  button.disabled = true;
  button.textContent = 'Verificando acesso…';
  setMessage('loginMessage', '');
  try {
    const { error } = await client.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
    if (error) throw error;
    await refreshSession();
  } catch {
    setMessage('loginMessage', 'Não foi possível entrar. Confira os dados ou use a recuperação de senha.', true);
  } finally {
    button.disabled = false;
    button.textContent = 'Entrar com segurança';
  }
});

$('forgotPassword').addEventListener('click', async () => {
  if (!configured() || !client) return;
  const email = $('email').value.trim();
  if (!email) {
    setMessage('loginMessage', 'Informe seu e-mail para solicitar a recuperação de senha.');
    $('email').focus();
    return;
  }
  $('forgotPassword').disabled = true;
  try {
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}${location.pathname}?flow=password-recovery` });
    if (error) throw error;
    setMessage('loginMessage', 'Se este e-mail estiver cadastrado, você receberá instruções para redefinir a senha.');
  } catch {
    setMessage('loginMessage', 'Não foi possível solicitar a recuperação agora. Tente novamente mais tarde.', true);
  } finally {
    $('forgotPassword').disabled = false;
  }
});

$('resetForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!client) return;
  const password = $('newPassword').value;
  if (password.length < 12) {
    setMessage('resetMessage', 'Use uma senha com pelo menos 12 caracteres.', true);
    return;
  }
  try {
    const { error } = await client.auth.updateUser({ password });
    if (error) throw error;
    $('newPassword').value = '';
    setMessage('resetMessage', 'Senha atualizada. Entre novamente com sua nova senha.');
    await client.auth.signOut();
    showLogin();
  } catch {
    setMessage('resetMessage', 'Não foi possível atualizar a senha. Solicite um novo link de recuperação.', true);
  }
});

$('logoutButton').addEventListener('click', async () => {
  if (!client) return;
  await client.auth.signOut();
  $('projectList').replaceChildren();
  $('password').value = '';
  showLogin();
});

init().catch(() => {
  configWarning.classList.remove('hidden');
  setMessage('loginMessage', 'Não foi possível iniciar o portal. Tente novamente mais tarde.', true);
});
