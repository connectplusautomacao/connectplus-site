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
let pendingNotificationNotices = [];
let pendingSignatureDocument = null;

function updateFingerprint(update) {
  return [update.created_at || '', update.title || '', update.message || ''].join('|');
}

function updateSeenKey(userId, projectId) {
  return `connectplus.portal.updates.${userId}.${projectId}`;
}

function notificationSeenKey(userId, projectId, kind) {
  return kind === 'project'
    ? updateSeenKey(userId, projectId)
    : `connectplus.portal.${kind}.${userId}.${projectId}`;
}

function findUnseenNotifications(userId, projectId, kind, records, fingerprint) {
  const key = notificationSeenKey(userId, projectId, kind);
  const fingerprints = records.map(fingerprint);
  try {
    const saved = localStorage.getItem(key);
    if (saved === null) {
      // Existing records become a baseline; only later changes are announced as new.
      localStorage.setItem(key, JSON.stringify(fingerprints.slice(0, 100)));
      return [];
    }
    const seen = new Set(JSON.parse(saved));
    return records.filter((record) => !seen.has(fingerprint(record)));
  } catch {
    return [];
  }
}

function markPendingNotificationsSeen() {
  for (const notice of pendingNotificationNotices) {
    const key = notificationSeenKey(currentUser.id, notice.projectId, notice.kind);
    try {
      const saved = localStorage.getItem(key);
      const seen = new Set(saved ? JSON.parse(saved) : []);
      for (const fingerprint of notice.fingerprints) seen.add(fingerprint);
      localStorage.setItem(key, JSON.stringify([...seen].slice(-100)));
    } catch {
      // The portal still works if this browser blocks local storage.
    }
  }
  pendingNotificationNotices = [];
  document.querySelectorAll('.notification-event-new').forEach((event) => {
    event.classList.remove('notification-event-new');
    event.querySelector('.notification-new-badge')?.remove();
  });
  document.querySelectorAll('.notification-summary').forEach((summary) => {
    const title = summary.querySelector('strong');
    const message = summary.querySelector('p');
    if (title) title.textContent = 'Acompanhe tudo por aqui';
    if (message) message.textContent = 'Veja o andamento, os documentos liberados e o histórico do suporte.';
  });
}

function showUpdateNotice() {
  const notice = $('updateNotice');
  if (!pendingNotificationNotices.length) {
    notice.classList.add('hidden');
    return;
  }
  const count = pendingNotificationNotices.reduce((total, item) => total + item.fingerprints.length, 0);
  $('updateNoticeText').textContent = count === 1
    ? 'Há uma nova atualização, documento ou resposta em um dos seus projetos.'
    : `Há ${count} novas atualizações, documentos ou respostas nos seus projetos.`;
  notice.classList.remove('hidden');
}

function dismissUpdateNotice() {
  markPendingNotificationsSeen();
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

function formatDateTime(value) {
  if (!value) return 'Data indisponível';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Data indisponível' : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function documentFingerprint(document) {
  return [document.storage_path || '', document.title || '', document.created_at || ''].join('|');
}

function supportFingerprint(request) {
  return [request.id || '', request.status || '', request.updated_at || request.created_at || ''].join('|');
}

function renderNotificationCenter(projectNode, updates, documents, supportRequests, unseenEvents, signatures = []) {
  supportRequests = supportRequests || [];
  const signaturesByDocument = new Map(signatures.map((signature) => [signature.document_id, signature]));
  const section = document.createElement('section');
  section.className = 'client-notification-center';
  section.setAttribute('aria-label', 'Novidades do projeto');
  const items = [
    ...updates.map((record) => ({ kind: 'project', fingerprint: updateFingerprint(record), title: record.title || 'Andamento do projeto atualizado', message: record.message || '', date: record.created_at, record })),
    ...documents.map((record) => {
      const signature = signaturesByDocument.get(record.id);
      return {
        kind: 'documents', fingerprint: documentFingerprint(record),
        title: signature ? 'Documento assinado' : record.title || 'Novo documento disponível',
        message: signature
          ? `Assinado por ${signature.signer_name} em ${formatDateTime(signature.signed_at)}.`
          : 'Documento liberado para consulta neste portal.',
        date: signature?.signed_at || record.created_at, record, signature,
      };
    }),
    ...supportRequests.filter((record) => record.updated_at && record.created_at
      && new Date(record.updated_at).valueOf() - new Date(record.created_at).valueOf() > 2000).map((record) => ({
      kind: 'support', fingerprint: supportFingerprint(record), title: 'A equipe atualizou seu atendimento',
      message: `O chamado “${record.subject || 'Suporte técnico'}” está com o status: ${record.status || 'Em análise'}.`,
      date: record.updated_at, record,
    })),
  ].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const unseen = new Set(unseenEvents.map((event) => `${event.kind}:${event.fingerprint}`));
  const newCount = unseen.size;
  const header = document.createElement('div');
  header.className = 'client-notification-heading';
  const titleBlock = document.createElement('div');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'AVISOS DO PROJETO';
  const title = document.createElement('h3');
  title.textContent = 'Novidades do seu projeto';
  const subtitle = document.createElement('p');
  subtitle.textContent = 'Atualizações, documentos e respostas da equipe em um só lugar.';
  titleBlock.append(eyebrow, title, subtitle);
  const count = document.createElement('span');
  count.className = 'notification-count';
  count.textContent = `${items.length} ${items.length === 1 ? 'aviso' : 'avisos'}`;
  header.append(titleBlock, count);

  const summary = document.createElement('div');
  summary.className = 'notification-summary';
  const summaryTitle = document.createElement('strong');
  summaryTitle.textContent = newCount ? `Você tem ${newCount} ${newCount === 1 ? 'novidade' : 'novidades'}` : 'Acompanhe tudo por aqui';
  const summaryText = document.createElement('p');
  summaryText.textContent = newCount
    ? 'Há uma nova atualização, documento ou resposta da equipe.'
    : 'Veja o andamento, os documentos liberados e o histórico do suporte.';
  summary.append(summaryTitle, summaryText);

  const filters = document.createElement('div');
  filters.className = 'notification-filters';
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filtrar avisos do projeto');
  const feed = document.createElement('div');
  feed.className = 'notification-feed';
  feed.setAttribute('aria-live', 'polite');
  const filterButtons = [];
  const filterOptions = [
    ['all', `Tudo · ${items.length}`],
    ['project', `Projeto · ${items.filter((item) => item.kind === 'project').length}`],
    ['documents', `Documentos · ${items.filter((item) => item.kind === 'documents').length}`],
    ['support', `Suporte · ${items.filter((item) => item.kind === 'support').length}`],
  ];
  let activeFilter = 'all';
  const renderFilter = () => {
    for (const button of filterButtons) button.setAttribute('aria-pressed', String(button.dataset.filter === activeFilter));
    for (const event of feed.children) event.hidden = activeFilter !== 'all' && event.dataset.kind !== activeFilter;
  };
  for (const [kind, label] of filterOptions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'notification-filter';
    button.dataset.filter = kind;
    button.textContent = label;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => { activeFilter = kind; renderFilter(); });
    filterButtons.push(button);
    filters.append(button);
  }
  for (const item of items) {
    const event = document.createElement('article');
    event.className = 'notification-event';
    event.dataset.kind = item.kind;
    const isNew = unseen.has(`${item.kind}:${item.fingerprint}`);
    if (isNew) event.classList.add('notification-event-new');
    const icon = document.createElement('span');
    icon.className = 'notification-event-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = item.kind === 'project' ? '↗' : item.kind === 'documents' ? '▤' : '✓';
    const content = document.createElement('div');
    content.className = 'notification-event-content';
    const eventTitle = document.createElement('h4');
    eventTitle.textContent = item.title;
    if (isNew) {
      const badge = document.createElement('span');
      badge.className = 'notification-new-badge';
      badge.textContent = 'Novo';
      eventTitle.append(' ', badge);
    }
    const message = document.createElement('p');
    message.textContent = item.message;
    const date = document.createElement('small');
    date.textContent = formatDateTime(item.date);
    content.append(eventTitle, message);
    if (item.kind === 'documents') {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'notification-document-action';
      const canSign = /contrato/i.test(`${item.record.title || ''} ${item.record.file_name || ''}`)
        && /\.pdf$/i.test(item.record.file_name || '') && !item.signature;
      action.textContent = canSign ? 'Revisar e assinar' : 'Baixar documento';
      action.addEventListener('click', () => canSign ? openSignatureDialog(item.record) : downloadDocument(item.record, action));
      content.append(action);
    }
    content.append(date);
    event.append(icon, content);
    feed.append(event);
  }
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'notification-empty';
    empty.textContent = 'As novidades do seu projeto aparecerão aqui.';
    feed.append(empty);
  }
  renderFilter();
  section.append(header, summary, filters, feed);
  projectNode.querySelector('.summary').after(section);
  return section;
}

function addEmpty(container, message) {
  // Auth can emit overlapping session events; keep each empty state single.
  if (container.querySelector('.empty')) return;
  const box = document.createElement('div');
  box.className = 'empty';
  box.textContent = message;
  container.append(box);
}

function renderProject(project, updates, documents, unseenEvents = [], supportRequests = [], signatures = []) {
  const node = $('projectTemplate').content.firstElementChild.cloneNode(true);
  node.dataset.projectId = String(project.id);
  node.querySelector('[data-field="code"]').textContent = project.code;
  node.querySelector('[data-field="title"]').textContent = project.title;
  node.querySelector('[data-field="status"]').textContent = project.status;
  const pct = Math.min(100, Math.max(0, Number(project.progress) || 0));
  node.querySelector('[data-field="progress"]').textContent = `${pct}%`;
  node.querySelector('[data-field="progressBar"]').style.width = `${pct}%`;
  node.querySelector('[data-field="nextStep"]').textContent = project.next_step || 'A equipe atualizará em breve';
  node.querySelector('[data-field="expectedDate"]').textContent = formatDate(project.expected_date);
  renderNotificationCenter(node, updates, documents, supportRequests, unseenEvents, signatures);

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
    const isNew = unseenEvents.some((event) => event.kind === 'project' && event.fingerprint === updateFingerprint(update));
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
  node.querySelector('.updates-section')?.remove();
  docsBox.previousElementSibling?.remove();
  docsBox.remove();
  $('projectList').append(node);
  const form = node.querySelector('[data-field="supportForm"]');
  enhanceSupportSection(node);
  form.addEventListener('submit', (event) => submitSupport(event, project.id, node));
  loadSupportHistory(project.id, node, supportRequests);
}

function enhanceSupportSection(projectNode) {
  const section = projectNode.querySelector('.support-section');
  const form = section.querySelector('[data-field="supportForm"]');
  const history = section.querySelector('[data-field="supportHistory"]');
  section.classList.add('support-center');
  section.querySelector('h3').textContent = 'Central de suporte';
  const intro = section.querySelector('.sub');
  intro.textContent = 'Envie sua solicitação e acompanhe o atendimento por aqui.';

  const workspace = document.createElement('div');
  workspace.className = 'support-workspace';
  const formCard = document.createElement('div');
  formCard.className = 'support-form-card';
  const formTitle = document.createElement('h4');
  formTitle.textContent = 'Nova solicitação';
  formCard.append(formTitle, form);

  const side = document.createElement('aside');
  side.className = 'support-side';
  const steps = document.createElement('section');
  steps.className = 'support-steps-card';
  const stepsTitle = document.createElement('h4');
  stepsTitle.textContent = 'Etapas do atendimento';
  steps.append(stepsTitle);
  for (const [index, label] of ['Recebido', 'Em análise', 'Em atendimento', 'Concluído'].entries()) {
    const step = document.createElement('p');
    step.className = 'support-step';
    const number = document.createElement('span');
    number.textContent = String(index + 1);
    const text = document.createElement('span');
    text.textContent = label;
    step.append(number, text);
    steps.append(step);
  }
  side.append(steps, history);
  workspace.append(formCard, side);
  section.append(workspace);

  const phoneLabel = form.querySelector('label:nth-of-type(2)');
  if (phoneLabel) phoneLabel.firstChild.textContent = 'Telefone para retorno (opcional)';
  const descriptionLabel = form.querySelector('label:nth-of-type(3)');
  if (descriptionLabel) descriptionLabel.firstChild.textContent = 'Descreva o que aconteceu';
  const textarea = form.querySelector('textarea');
  if (textarea) textarea.placeholder = 'Ex.: a luz da sala não responde pelo aplicativo desde ontem.';
  form.querySelector('button[type="submit"]').textContent = 'Enviar solicitação';
}

function supportStatusClass(status) {
  const normalized = String(status || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (normalized === 'concluido') return 'done';
  if (normalized === 'em analise' || normalized === 'em atendimento') return 'progress';
  return 'received';
}

function formatCurrency(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value) || 0);
}

async function loadSupportHistory(projectId, node, supportRequests = null) {
  let data = supportRequests;
  let error = null;
  if (!data) ({ data, error } = await client.from('support_requests')
    .select('id, subject, status, created_at, updated_at').eq('project_id', projectId)
    .eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(5));
  const box = node.querySelector('[data-field="supportHistory"]');
  box.replaceChildren();
  box.classList.add('support-history-card');
  const title = document.createElement('h4');
  title.textContent = 'Seus atendimentos';
  box.append(title);
  if (error || !data?.length) {
    const empty = document.createElement('p');
    empty.className = 'support-history-empty';
    empty.textContent = error ? 'Não foi possível carregar o histórico agora.' : 'As solicitações enviadas aparecerão aqui.';
    box.append(empty);
    return;
  }
  for (const request of data.slice(0, 5)) {
    const row = document.createElement('article');
    row.className = 'support-history-row';
    const summary = document.createElement('div');
    const subject = document.createElement('strong');
    subject.textContent = request.subject || 'Solicitação de suporte';
    const date = document.createElement('small');
    date.textContent = formatDate(request.created_at?.slice(0, 10));
    summary.append(subject, date);
    const status = document.createElement('span');
    status.className = `support-status ${supportStatusClass(request.status)}`;
    status.textContent = request.status || 'Recebido';
    row.append(summary, status);
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
  messageBox.classList.remove('error', 'success');
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
    messageBox.classList.add('success');
    await loadSupportHistory(projectId, node);
  } catch {
    messageBox.textContent = 'Não foi possível enviar agora. Verifique sua conexão e tente novamente.';
    messageBox.classList.add('error');
  } finally {
    button.disabled = false;
  }
}

async function openSignatureDialog(doc) {
  pendingSignatureDocument = doc;
  const dialog = $('signatureDialog');
  $('signatureDocumentTitle').textContent = doc.title || 'Documento Connect Plus';
  $('signatureDocumentFile').textContent = doc.file_name || 'Arquivo protegido no portal';
  $('signatureSignerName').value = '';
  $('signatureConsent').checked = false;
  $('signatureStatus').textContent = '';
  $('signatureStatus').classList.remove('error', 'success');
  $('confirmSignature').hidden = false;
  $('confirmSignature').disabled = false;
  $('signatureClose').textContent = 'Voltar';
  dialog.showModal();
}

async function callClientSignature(payload) {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session?.access_token) throw new Error('Sua sessão expirou. Entre novamente no portal.');
  const response = await fetch(`${SUPABASE_URL}/functions/v1/client-projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Não foi possível registrar a assinatura agora.');
  return result;
}

async function confirmClientSignature() {
  const button = $('confirmSignature');
  const status = $('signatureStatus');
  const signerName = $('signatureSignerName').value.trim();
  if (!pendingSignatureDocument) return;
  if (signerName.length < 2) {
    status.textContent = 'Informe seu nome completo para continuar.';
    status.classList.add('error');
    $('signatureSignerName').focus();
    return;
  }
  if (!$('signatureConsent').checked) {
    status.textContent = 'Confirme que leu o documento e concorda em assiná-lo eletronicamente.';
    status.classList.add('error');
    return;
  }
  button.disabled = true;
  button.textContent = 'Registrando assinatura…';
  status.textContent = '';
  status.classList.remove('error', 'success');
  try {
    const result = await callClientSignature({
      action: 'client_sign_document',
      documentId: pendingSignatureDocument.id,
      signerName,
      accepted: true,
    });
    const receipt = result.signature?.id ? String(result.signature.id) : 'registrado';
    status.textContent = result.alreadySigned
      ? 'Este documento já consta como assinado pela sua conta.'
      : `Assinatura registrada. Comprovante ${receipt}. A confirmação ficou vinculada a esta versão do documento.`;
    status.classList.add('success');
    button.hidden = true;
    $('signatureClose').textContent = 'Concluir';
    try { await loadProjects(currentUser); } catch { /* The recorded signature remains confirmed if a later refresh fails. */ }
  } catch (error) {
    status.textContent = error.message || 'Não foi possível registrar a assinatura.';
    status.classList.add('error');
    button.disabled = false;
    button.textContent = 'Continuar para assinar';
  }
}

async function downloadDocument(doc, button) {
  const idleLabel = button.textContent;
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
    button.textContent = idleLabel;
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
  pendingNotificationNotices = [];
  if (!projects.length) {
    addEmpty($('projectList'), 'Nenhum projeto foi liberado para esta conta. Se precisar de ajuda, fale com a Connect Plus.');
    return;
  }
  for (const project of projects) {
    const [updatesResult, docsResult, supportResult] = await Promise.all([
      client.from('project_updates').select('title, message, created_at').eq('project_id', project.id).eq('visible_to_client', true).order('created_at', { ascending: false }),
      client.from('project_documents').select('id, title, file_name, storage_path, created_at').eq('project_id', project.id).eq('visible_to_client', true).order('created_at', { ascending: false }),
      client.from('support_requests').select('id, subject, status, created_at, updated_at').eq('project_id', project.id).eq('user_id', user.id).order('created_at', { ascending: false }).limit(20),
    ]);
    const { data: updates, error: updatesError } = updatesResult;
    const { data: docs, error: docsError } = docsResult;
    const { data: supportRequests, error: supportError } = supportResult;
    if (updatesError || docsError) throw updatesError || docsError;
    const signatureResult = await client.from('client_document_signatures')
      .select('id, document_id, signer_name, signed_at, document_sha256')
      .eq('project_id', project.id).eq('user_id', user.id).order('signed_at', { ascending: false });
    if (requestGeneration !== projectLoadGeneration) return;
    const projectUpdates = updates || [];
    const projectDocuments = docs || [];
    const requests = supportRequests || [];
    const changedSupport = requests.filter((request) => request.updated_at && request.created_at
      && new Date(request.updated_at).valueOf() - new Date(request.created_at).valueOf() > 2000);
    const unseenEvents = [
      ...findUnseenNotifications(user.id, project.id, 'project', projectUpdates, updateFingerprint).map((record) => ({ kind: 'project', fingerprint: updateFingerprint(record) })),
      ...findUnseenNotifications(user.id, project.id, 'documents', projectDocuments, documentFingerprint).map((record) => ({ kind: 'documents', fingerprint: documentFingerprint(record) })),
      ...findUnseenNotifications(user.id, project.id, 'support', changedSupport, supportFingerprint).map((record) => ({ kind: 'support', fingerprint: supportFingerprint(record) })),
    ];
    for (const kind of ['project', 'documents', 'support']) {
      const fingerprints = unseenEvents.filter((event) => event.kind === kind).map((event) => event.fingerprint);
      if (fingerprints.length) pendingNotificationNotices.push({ projectId: project.id, kind, fingerprints });
    }
    renderProject(project, projectUpdates, projectDocuments, unseenEvents, supportError ? null : requests, signatureResult.error ? [] : (signatureResult.data || []));
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
  const firstProjectId = pendingNotificationNotices[0]?.projectId;
  dismissUpdateNotice();
  if (!firstProjectId) return;
  [...$('projectList').children].find((project) => project.dataset.projectId === String(firstProjectId))
    ?.querySelector('.client-notification-center')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('updateNoticeDismiss').addEventListener('click', dismissUpdateNotice);
$('signatureClose').addEventListener('click', () => $('signatureDialog').close());
$('confirmSignature').addEventListener('click', confirmClientSignature);
$('downloadSignatureDocument').addEventListener('click', () => {
  if (pendingSignatureDocument) downloadDocument(pendingSignatureDocument, $('downloadSignatureDocument'));
});

init().catch(() => {
  configWarning.classList.remove('hidden');
  setMessage('loginMessage', 'Não foi possível iniciar o portal. Tente novamente mais tarde.', true);
});
