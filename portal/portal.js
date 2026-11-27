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
let passwordRecoveryActive = false;
let firstAccessInviteActive = false;
let projectLoadGeneration = 0;
let currentUser = null;
let pendingUpdateNotices = [];

function updateFingerprint(update) {
  return [update.created_at || '', update.title || '', update.message || ''].join('|');
}

function updateSeenKey(userId, projectId) {
  return `connectplus.portal.updates.${userId}.${projectId}`;
}

function findUnseenUpdates(userId, projectId, updates) {
  const key = updateSeenKey(userId, projectId);
  const fingerprints = updates.map(updateFingerprint);
  try {
    const saved = localStorage.getItem(key);
    if (saved === null) {
      // Establish a baseline on the first visit, so old updates are not shown as new.
      localStorage.setItem(key, JSON.stringify(fingerprints.slice(0, 100)));
      return [];
    }
    const seen = new Set(JSON.parse(saved));
    return updates.filter((update) => !seen.has(updateFingerprint(update)));
  } catch {
    return [];
  }
}

function markPendingUpdatesSeen() {
  for (const notice of pendingUpdateNotices) {
    const key = updateSeenKey(currentUser.id, notice.projectId);
    try {
      const saved = localStorage.getItem(key);
      const seen = new Set(saved ? JSON.parse(saved) : []);
      for (const fingerprint of notice.fingerprints) seen.add(fingerprint);
      localStorage.setItem(key, JSON.stringify([...seen].slice(-100)));
    } catch {
      // The portal still works if this browser blocks local storage.
    }
  }
  pendingUpdateNotices = [];
}

function showUpdateNotice() {
  const notice = $('updateNotice');
  if (!pendingUpdateNotices.length) {
    notice.classList.add('hidden');
    return;
  }
  const count = pendingUpdateNotices.reduce((total, item) => total + item.fingerprints.length, 0);
  $('updateNoticeText').textContent = count === 1
    ? 'Há uma nova atualização em um dos seus projetos.'
    : `Há ${count} novas atualizações nos seus projetos.`;
  notice.classList.remove('hidden');
}

function dismissUpdateNotice() {
  markPendingUpdatesSeen();
  $('updateNotice').classList.add('hidden');
}

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

function showPasswordReset() {
  loginCard.classList.add('hidden');
  dashboard.classList.add('hidden');
  resetCard.classList.remove('hidden');
  updatePasswordScreen();
}

function hasPasswordRecoveryUrl() {
  const params = new URLSearchParams(location.search);
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  return params.get('flow') === 'password-recovery'
    || ['recovery', 'invite'].includes(hashParams.get('type'));
}

function isFirstAccessInvite() {
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  return firstAccessInviteActive || hashParams.get('type') === 'invite';
}

function updatePasswordScreen() {
  const firstAccess = isFirstAccessInvite();
  $('resetTitle').textContent = firstAccess ? 'Criar senha de acesso' : 'Redefinir senha';
  $('resetDescription').textContent = firstAccess
    ? 'Defina uma senha pessoal para acompanhar seu projeto.'
    : 'Informe sua nova senha para continuar.';
  $('resetButton').textContent = firstAccess ? 'Criar minha senha' : 'Salvar nova senha';
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
  // Auth can emit overlapping session events; keep each empty state single.
  if (container.querySelector('.empty')) return;
  const box = document.createElement('div');
  box.className = 'empty';
  box.textContent = message;
  container.append(box);
}

function renderProject(project, updates, documents, unseenFingerprints = []) {
  const node = $('projectTemplate').content.firstElementChild.cloneNode(true);
  node.querySelector('[data-field="code"]').textContent = project.code;
  node.querySelector('[data-field="title"]').textContent = project.title;
  node.querySelector('[data-field="status"]').textContent = project.status;
  const pct = Math.min(100, Math.max(0, Number(project.progress) || 0));
  node.querySelector('[data-field="progress"]').textContent = `${pct}%`;
  node.querySelector('[data-field="progressBar"]').style.width = `${pct}%`;
  node.querySelector('[data-field="nextStep"]').textContent = project.next_step || 'A equipe atualizará em breve';
  node.querySelector('[data-field="expectedDate"]').textContent = formatDate(project.expected_date);

  const proposal = project.approved_proposal;
  if (proposal && typeof proposal === 'object') {
    node.querySelector('[data-field="proposal"]').hidden = false;
    const details = node.querySelector('[data-field="proposalDetails"]');
    const summary = document.createElement('p');
    summary.textContent = proposal.summary || 'Automação residencial Connect Plus';
    details.append(summary);
    const meta = document.createElement('div');
    meta.className = 'proposal-meta';
    for (const [label, value] of [['Nº da proposta', proposal.code], ['Data da proposta', formatDate(proposal.date)], ['Aprovada em', proposal.approvedAt], ['Validade', proposal.validity], ['Prazo estimado', proposal.deadline], ['Forma de pagamento', proposal.payment]]) {
      if (!value) continue;
      const item = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = `${label}: `;
      item.append(strong, document.createTextNode(String(value)));
      meta.append(item);
    }
    details.append(meta);
    if (Array.isArray(proposal.items) && proposal.items.length) {
      const list = document.createElement('div');
      list.className = 'proposal-items';
      for (const row of proposal.items) {
        const item = document.createElement('p');
        item.textContent = `${row.description} · ${row.quantity} × ${formatCurrency(row.unitPrice)} = ${formatCurrency(row.total)}`;
        list.append(item);
      }
      details.append(list);
    }
    if (Number.isFinite(Number(proposal.total))) {
      const total = document.createElement('p');
      total.className = 'proposal-total';
      total.textContent = `Total aprovado: ${formatCurrency(proposal.total)}`;
      details.append(total);
    }
  }

  const updatesBox = node.querySelector('[data-field="updates"]');
  updatesBox.id = `updates-${String(project.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  node.querySelector('[data-field="updatesCount"]').textContent = `${updates.length} ${updates.length === 1 ? 'registro' : 'registros'}`;
  if (!updates.length) addEmpty(updatesBox, 'Nenhuma atualização publicada até o momento.');
  for (const [index, update] of updates.entries()) {
    const item = $('updateTemplate').content.firstElementChild.cloneNode(true);
    const isNew = unseenFingerprints.includes(updateFingerprint(update));
    item.classList.toggle('update-new', isNew);
    item.classList.toggle('update-latest', index === 0 && !isNew);
    item.querySelector('[data-field="title"]').textContent = update.title;
    item.querySelector('[data-field="message"]').textContent = update.message;
    item.querySelector('[data-field="date"]').textContent = formatDate(update.created_at?.slice(0, 10));
    const badge = item.querySelector('[data-field="badge"]');
    if (isNew) {
      badge.textContent = 'Nova';
      badge.hidden = false;
    } else if (index === 0) {
      badge.textContent = 'Mais recente';
      badge.hidden = false;
    }
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
  const form = node.querySelector('[data-field="supportForm"]');
  form.addEventListener('submit', (event) => submitSupport(event, project.id, node));
  loadSupportHistory(project.id, node);
}

function formatCurrency(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value) || 0);
}

async function loadSupportHistory(projectId, node) {
  const { data, error } = await client.from('support_requests')
    .select('subject, status, created_at').eq('project_id', projectId)
    .eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(5);
  const box = node.querySelector('[data-field="supportHistory"]');
  box.replaceChildren();
  if (error || !data?.length) return;
  const title = document.createElement('h4');
  title.textContent = 'Suas solicitações recentes';
  box.append(title);
  for (const request of data) {
    const row = document.createElement('p');
    row.textContent = `${request.subject} · ${request.status} · ${formatDate(request.created_at?.slice(0, 10))}`;
    box.append(row);
  }
}

async function submitSupport(event, projectId, node) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const values = new FormData(form);
  const messageBox = node.querySelector('[data-field="supportMessage"]');
  button.disabled = true;
  messageBox.textContent = 'Enviando sua solicitação…';
  messageBox.classList.remove('error');
  try {
    const { error } = await client.from('support_requests').insert({
      project_id: projectId,
      user_id: currentUser.id,
      subject: String(values.get('subject') || '').trim(),
      contact_phone: String(values.get('phone') || '').trim(),
      message: String(values.get('message') || '').trim(),
    });
    if (error) throw error;
    form.reset();
    messageBox.textContent = 'Solicitação enviada. A equipe Connect Plus poderá acompanhar o atendimento.';
    await loadSupportHistory(projectId, node);
  } catch {
    messageBox.textContent = 'Não foi possível enviar agora. Verifique sua conexão e tente novamente.';
    messageBox.classList.add('error');
  } finally {
    button.disabled = false;
  }
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
  const requestGeneration = ++projectLoadGeneration;
  $('projectList').replaceChildren();
  $('welcome').textContent = 'Projetos liberados para você';
  const { data: memberships, error: membershipError } = await client
    .from('project_members')
    .select('project_id, projects!inner(id, code, title, status, progress, next_step, expected_date, approved_proposal)')
    .eq('user_id', user.id);
  if (membershipError) throw membershipError;
  if (requestGeneration !== projectLoadGeneration) return;
  const projects = (memberships || []).map((m) => m.projects).filter(Boolean);
  pendingUpdateNotices = [];
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
    if (requestGeneration !== projectLoadGeneration) return;
    const unseen = findUnseenUpdates(user.id, project.id, updates || []);
    if (unseen.length) {
      pendingUpdateNotices.push({
        projectId: project.id,
        fingerprints: unseen.map(updateFingerprint),
      });
    }
    renderProject(project, updates || [], docs || [], unseen.map(updateFingerprint));
  }
  showUpdateNotice();
}

function showError(message) {
  $('errorText').textContent = message;
  $('errorDialog').showModal();
}

async function refreshSession() {
  if (passwordRecoveryActive || hasPasswordRecoveryUrl()) {
    passwordRecoveryActive = true;
    showPasswordReset();
    return;
  }
  if (!configured()) return;
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) {
    showLogin();
    return;
  }
  try {
    currentUser = data.session.user;
    showDashboard(data.session.user.email);
    await loadProjects(data.session.user);
  } catch {
    showLogin();
    setMessage('loginMessage', 'Não foi possível carregar seus projetos. Tente novamente.', true);
  }
}

async function init() {
  firstAccessInviteActive = isFirstAccessInvite();
  passwordRecoveryActive = hasPasswordRecoveryUrl();
  if (passwordRecoveryActive) showPasswordReset();
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
  client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      passwordRecoveryActive = true;
      showPasswordReset();
      return;
    }
    if (passwordRecoveryActive) {
      showPasswordReset();
      return;
    }
    if (event === 'SIGNED_OUT') {
      projectLoadGeneration++;
      showLogin();
    }
    if (event === 'SIGNED_IN' && session) setTimeout(() => refreshSession(), 0);
  });
  if (!passwordRecoveryActive) await refreshSession();
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
  const firstAccess = isFirstAccessInvite();
  const password = $('newPassword').value;
  if (password.length < 12) {
    setMessage('resetMessage', 'Use uma senha com pelo menos 12 caracteres.', true);
    return;
  }
  try {
    const { error } = await client.auth.updateUser({ password });
    if (error) throw error;
    $('newPassword').value = '';
    setMessage('loginMessage', firstAccess
      ? 'Senha criada. Entre no portal com seu e-mail e a nova senha.'
      : 'Senha atualizada. Entre novamente com sua nova senha.');
    setMessage('resetMessage', '');
    firstAccessInviteActive = false;
    passwordRecoveryActive = false;
    history.replaceState(null, '', location.pathname);
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

$('updateNoticeView').addEventListener('click', () => {
  const firstProjectId = pendingUpdateNotices[0]?.projectId;
  dismissUpdateNotice();
  if (!firstProjectId) return;
  document.getElementById(`updates-${String(firstProjectId).replace(/[^a-zA-Z0-9_-]/g, '-')}`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('updateNoticeDismiss').addEventListener('click', dismissUpdateNotice);

init().catch(() => {
  configWarning.classList.remove('hidden');
  setMessage('loginMessage', 'Não foi possível iniciar o portal. Tente novamente mais tarde.', true);
});
