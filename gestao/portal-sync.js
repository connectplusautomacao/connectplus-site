import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cfg = window.CONNECTPLUS_PORTAL_SYNC || {};
const portalUrl = String(cfg.url || '').replace(/\/$/, '');
const portalKey = cfg.publishableKey || '';
const actionUrl = `${portalUrl}/functions/v1/client-projects`;
const documentBucket = 'client-documents';
const maxDocumentBytes = 15 * 1024 * 1024;
const safeText = (value) => String(value ?? '').trim();
let portalStorageClient = null;
let portalControlsInitialized = false;
let supportControlsInitialized = false;
let supportPollTimer = null;
let supportRequestsCache = [];
let supportUnseenIds = new Set();
let supportSeenStorageKey = '';
let supportFilter = 'open';
let portalRole = null;
let quoteObserver = null;
let documentProjectObserver = null;
let quoteClickHandler = null;

function hasPortalAdminAccess() {
  return portalRole === 'owner' || portalRole === 'admin';
}

function hasTeamSupportAccess() {
  return ['owner', 'admin', 'technician'].includes(portalRole);
}

function removePortalControls() {
  quoteObserver?.disconnect();
  documentProjectObserver?.disconnect();
  quoteObserver = null;
  documentProjectObserver = null;
  const quotes = document.getElementById('savedQuotes');
  if (quotes && quoteClickHandler) quotes.removeEventListener('click', quoteClickHandler);
  if (quotes) {
    quotes.querySelectorAll('.portal-release').forEach((button) => button.remove());
    delete quotes.dataset.portalBound;
  }
  document.getElementById('publishPortalProgress')?.closest('.portal-progress-controls')?.remove();
  document.getElementById('portalSupportInbox')?.remove();
  document.getElementById('portalDocumentUpload')?.remove();
  if (supportPollTimer) clearInterval(supportPollTimer);
  supportPollTimer = null;
  supportControlsInitialized = false;
  supportRequestsCache = [];
  supportUnseenIds = new Set();
  supportSeenStorageKey = '';
  const supportBadge = document.getElementById('supportOpenBadge');
  if (supportBadge) { supportBadge.hidden = true; supportBadge.textContent = ''; }
  portalControlsInitialized = false;
}

function setPortalRole(role) {
  portalRole = role;
  if (!hasPortalAdminAccess()) removePortalControls();
  if (!hasTeamSupportAccess()) return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSupportControls, { once: true });
  } else {
    initSupportControls();
  }
  if (!hasPortalAdminAccess()) return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}

window.__cpPortalSetRole = setPortalRole;

function quoteFingerprint(q) {
  return JSON.stringify({
    number: q.number, date: q.date, client: q.client, email: q.email, summary: q.summary,
    payment: q.payment, deadline: q.deadline, validity: q.validity,
    items: (q.items || []).map((item) => ({ name: item.name, qty: item.qty, price: item.price })),
  });
}

function updateStatus(text, error = false) {
  document.querySelectorAll('.portal-sync-status').forEach((el) => {
    el.textContent = text;
    el.classList.toggle('error', error);
  });
}

async function callFunction(payload) {
  if (!hasPortalAdminAccess()) throw new Error('Esta ação está disponível somente para administradores.');
  if (!portalUrl || !portalKey) throw new Error('A conexão do portal precisa ser configurada.');
  if (!window.__getInternalAccessToken) throw new Error('Entre novamente na plataforma da equipe.');
  const token = await window.__getInternalAccessToken();
  if (!token) throw new Error('Sua sessão expirou. Entre novamente na plataforma da equipe.');
  const response = await fetch(actionUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: portalKey, Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Não foi possível completar a sincronização.');
  return result;
}

async function callSupportFunction(payload) {
  if (!hasTeamSupportAccess()) throw new Error('Esta área está disponível somente para contas ativas da equipe.');
  if (!['support_list', 'support_update'].includes(payload?.action)) throw new Error('Ação de suporte inválida.');
  if (!portalUrl || !portalKey) throw new Error('A conexão do portal precisa ser configurada.');
  if (!window.__getTeamSupportAccessToken) throw new Error('Entre novamente na plataforma da equipe.');
  const token = await window.__getTeamSupportAccessToken();
  if (!token) throw new Error('Sua sessão expirou. Entre novamente na plataforma da equipe.');
  const response = await fetch(actionUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: portalKey, Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Não foi possível carregar as solicitações de suporte.');
  return result;
}

function proposalSnapshot(saved) {
  const q = saved.q;
  const items = (q.items || []).filter((item) => item.name).map((item) => {
    const quantity = Number(item.qty) || 0;
    const unitPrice = Number(item.price) || 0;
    return {
      description: safeText(item.name).slice(0, 180),
      quantity,
      unitPrice,
      total: Number((quantity * unitPrice).toFixed(2)),
    };
  });
  const total = Number(items.reduce((sum, item) => sum + item.total, 0).toFixed(2));
  return {
    code: safeText(saved.id),
    date: safeText(q.date),
    client: safeText(q.client).slice(0, 180),
    title: `Automação residencial · ${safeText(q.client || saved.id)}`.slice(0, 180),
    summary: safeText(q.summary).slice(0, 1600),
    items,
    total,
    payment: safeText(q.payment).slice(0, 240),
    deadline: safeText(q.deadline).slice(0, 240),
    validity: safeText(q.validity).slice(0, 120),
    approvedAt: q.approvedAt,
  };
}

async function releaseProposal(id) {
  const saved = window.__cpPortalBridge?.getSavedQuotes().find((row) => row.id === id);
  if (!saved) return;
  const email = safeText(saved.q.email).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    alert('Informe um e-mail válido no orçamento antes de liberar o portal.');
    document.getElementById('qEmail')?.focus();
    return;
  }
  if (!saved.q.approvedAt) {
    const accepted = confirm(`Confirme que ${saved.q.client || 'o cliente'} já aprovou a proposta ${saved.id} e que esta versão pode ser compartilhada no portal.`);
    if (!accepted) return;
    saved.q.approvedAt = new Date().toLocaleDateString('pt-BR');
    saved.q.approvedFingerprint = quoteFingerprint(saved.q);
    window.__cpPortalBridge.updateSavedQuote(saved);
  } else if (!confirm(`Enviar/atualizar a proposta aprovada ${saved.id} para ${email} no portal do cliente?`)) {
    return;
  }
  updateStatus('Liberando o acesso individual do cliente…');
  try {
    const result = await callFunction({ action: 'provision', email, code: saved.id, proposal: proposalSnapshot(saved) });
    saved.q.portal = { projectId: result.projectId, email, releasedAt: new Date().toISOString() };
    window.__cpPortalBridge.updateSavedQuote(saved);
    updateStatus(result.inviteSent
      ? `Projeto liberado. O convite de acesso foi enviado para ${email}.`
      : `Projeto associado à conta existente de ${email}.`);
    renderReleaseButtons();
  } catch (error) {
    updateStatus(error.message || 'Falha ao liberar o projeto.', true);
  }
}

function renderReleaseButtons() {
  const container = document.getElementById('savedQuotes');
  if (!container) return;
  container.querySelectorAll('.saved-row').forEach((row) => {
    const open = row.querySelector('.open-saved');
    if (!open) return;
    const id = open.dataset.id;
    const saved = window.__cpPortalBridge?.getSavedQuotes().find((item) => item.id === id);
    if (!saved) return;
    let button = row.querySelector('.portal-release');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'button secondary portal-release';
      button.dataset.id = id;
      row.lastElementChild?.prepend(button, document.createTextNode(' '));
    }
    button.textContent = saved.q.portal?.projectId ? 'Atualizar no portal' : 'Liberar no portal';
  });
}

function mapProgress(execution) {
  const map = {
    Agendada: ['Em planejamento', 5, 'A equipe está organizando as próximas etapas do projeto.'],
    'Em execução': ['Instalação', 55, 'A equipe está executando a instalação.'],
    'Aguardando material': ['Preparação', 35, 'A execução está aguardando a chegada de material.'],
    'Aguardando cliente': ['Preparação', 40, 'A equipe aguarda uma confirmação para continuar.'],
    Concluída: ['Concluído', 100, 'A execução foi concluída.'],
    'Concluída com pendências': ['Concluído com pendências', 100, 'Serviço concluído com sucesso. Eventuais pendências foram registradas para acompanhamento separado e não alteram a conclusão do projeto.'],
  };
  const [status, progress, nextStep] = map[execution.status] || map.Agendada;
  return { status, progress, nextStep };
}

async function publishExecution() {
  const execution = window.__cpPortalBridge?.getExecution();
  if (!execution?.quoteId) return updateStatus('Vincule a ordem de serviço a um orçamento salvo.', true);
  const saved = window.__cpPortalBridge.getSavedQuotes().find((row) => row.id === execution.quoteId);
  if (!saved?.q?.portal?.projectId) return updateStatus('Libere primeiro a proposta aprovada no portal do cliente.', true);
  const mapped = mapProgress(execution);
  if (!confirm(`Publicar no portal de ${saved.q.client || 'seu cliente'}: “${mapped.status}” (${mapped.progress}%). O cliente verá apenas o andamento e esta mensagem.`)) return;
  updateStatus('Atualizando o andamento no portal…');
  try {
    await callFunction({
      action: 'publish_progress',
      code: saved.id,
      ...mapped,
      updateTitle: 'Andamento da execução',
      message: `O status do projeto foi atualizado para “${mapped.status}”. ${mapped.nextStep}`,
    });
    updateStatus('Andamento publicado no portal do cliente.');
  } catch (error) {
    updateStatus(error.message || 'Falha ao publicar o andamento.', true);
  }
}

function supportPanel() {
  const host = document.getElementById('supportPanelContent');
  if (!host || document.getElementById('portalSupportInbox')) return;
  const section = document.createElement('section');
  section.id = 'portalSupportInbox';
  section.className = 'card support-inbox';
  section.innerHTML = '<div class="support-inbox-head"><div><p class="eyebrow">ATENDIMENTO AO CLIENTE</p><h2>Central de atendimentos</h2><p class="hint">Acompanhe solicitações abertas e atualize o andamento de cada chamado.</p></div><button type="button" class="button secondary" id="refreshPortalSupport">Atualizar lista</button></div><div class="support-stats"><div class="support-stat open"><small>Solicitações em aberto</small><strong id="supportOpenCount">—</strong></div><div class="support-stat new"><small>Novas desde sua última visita</small><strong id="supportNewCount">—</strong></div><div class="support-stat"><small>Concluídas</small><strong id="supportDoneCount">—</strong></div></div><div class="support-filters" role="group" aria-label="Filtrar solicitações"><button type="button" class="support-filter" data-support-filter="all">Todas</button><button type="button" class="support-filter active" data-support-filter="open">Em aberto</button><button type="button" class="support-filter" data-support-filter="done">Concluídas</button></div><div id="portalSupportList" class="support-ticket-list" aria-live="polite">Carregando solicitações…</div>';
  const toast = document.createElement('aside');
  toast.id = 'supportTicketToast';
  toast.className = 'support-ticket-toast';
  toast.hidden = true;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.innerHTML = '<span aria-hidden="true">✦</span><div><strong>Novo chamado recebido</strong><p id="supportTicketToastText"></p></div><button type="button" id="supportTicketToastButton">Ver chamado</button>';
  host.append(section, toast);
  document.getElementById('refreshPortalSupport').addEventListener('click', () => loadSupportRequests());
  section.querySelectorAll('[data-support-filter]').forEach((button) => button.addEventListener('click', () => {
    supportFilter = button.dataset.supportFilter;
    renderSupportRequests();
  }));
  document.getElementById('supportTicketToastButton').addEventListener('click', () => {
    markSupportRequestsSeen();
    document.getElementById('supportPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function decodeSupportToken(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))));
  } catch { return {}; }
}

function supportStatusClass(status) {
  const normalized = String(status || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (normalized === 'concluido') return 'done';
  if (normalized === 'em analise' || normalized === 'em atendimento') return 'progress';
  return 'received';
}

function isSupportRequestOpen(request) {
  const status = String(request.status || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return status !== 'concluido';
}

function markSupportRequestsSeen() {
  if (supportSeenStorageKey) {
    try {
      const saved = localStorage.getItem(supportSeenStorageKey);
      const seen = new Set(saved ? JSON.parse(saved) : []);
      supportRequestsCache.forEach((request) => seen.add(String(request.id)));
      localStorage.setItem(supportSeenStorageKey, JSON.stringify([...seen].slice(-500)));
    } catch { /* The queue remains usable if local storage is blocked. */ }
  }
  supportUnseenIds.clear();
  const toast = document.getElementById('supportTicketToast');
  if (toast) toast.hidden = true;
  renderSupportRequests();
}

window.__cpMarkSupportSeen = markSupportRequestsSeen;

function renderSupportRequests() {
  const list = document.getElementById('portalSupportList');
  if (!list) return;
  list.replaceChildren();
  const requests = [...supportRequestsCache].sort((a, b) => {
    const openDiff = Number(isSupportRequestOpen(b)) - Number(isSupportRequestOpen(a));
    return openDiff || String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });
  const visible = requests.filter((request) => supportFilter === 'all'
    || (supportFilter === 'open' && isSupportRequestOpen(request))
    || (supportFilter === 'done' && !isSupportRequestOpen(request)));
  document.querySelectorAll('[data-support-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.supportFilter === supportFilter);
    const count = button.dataset.supportFilter === 'all' ? requests.length
      : button.dataset.supportFilter === 'open' ? requests.filter(isSupportRequestOpen).length
        : requests.filter((request) => !isSupportRequestOpen(request)).length;
    const label = { all: 'Todas', open: 'Em aberto', done: 'Concluídas' }[button.dataset.supportFilter];
    button.textContent = `${label} · ${count}`;
  });
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = supportFilter === 'open' ? 'Nenhuma solicitação em aberto.' : 'Nenhuma solicitação nesta lista.';
    list.append(empty);
    return;
  }
  for (const request of visible) {
    const card = document.createElement('article');
    card.className = `support-admin-row${supportUnseenIds.has(String(request.id)) ? ' is-new' : ''}`;
    const head = document.createElement('div');
    head.className = 'support-admin-row-head';
    const title = document.createElement('strong');
    title.textContent = `${request.projects?.code || 'Projeto'} · ${request.subject || 'Solicitação de suporte'}`;
    const badges = document.createElement('div');
    if (supportUnseenIds.has(String(request.id))) {
      const fresh = document.createElement('span');
      fresh.className = 'support-ticket-state new';
      fresh.textContent = 'Nova';
      badges.append(fresh);
    }
    const state = document.createElement('span');
    state.className = `support-ticket-state ${supportStatusClass(request.status)}`;
    state.textContent = request.status || 'Recebido';
    badges.append(state);
    head.append(title, badges);

    const message = document.createElement('p');
    message.textContent = request.message || 'O cliente não incluiu detalhes adicionais.';
    const contact = document.createElement('div');
    contact.className = 'support-admin-meta';
    const customer = document.createElement('span');
    customer.textContent = `Cliente: ${request.client_email || 'e-mail não disponível'}`;
    const phone = document.createElement('span');
    phone.textContent = request.contact_phone ? `Telefone: ${request.contact_phone}` : 'Telefone não informado';
    const date = document.createElement('span');
    date.textContent = request.created_at ? new Date(request.created_at).toLocaleString('pt-BR') : '';
    contact.append(customer, phone, date);

    const actions = document.createElement('div');
    actions.className = 'support-admin-actions';
    const status = document.createElement('select');
    status.setAttribute('aria-label', 'Situação da solicitação');
    for (const value of ['Recebido', 'Em análise', 'Em atendimento', 'Concluído']) status.add(new Option(value, value));
    status.value = request.status || 'Recebido';
    const note = document.createElement('textarea');
    note.maxLength = 1000;
    note.placeholder = 'Nota interna para a equipe (não aparece ao cliente)';
    note.value = request.staff_note || '';
    const save = document.createElement('button');
    save.type = 'button'; save.className = 'button secondary'; save.textContent = 'Salvar atendimento';
    const feedback = document.createElement('small');
    feedback.setAttribute('role', 'status');
    save.addEventListener('click', async () => {
      save.disabled = true;
      feedback.textContent = 'Salvando…';
      try {
        await callSupportFunction({ action: 'support_update', id: request.id, status: status.value, staffNote: note.value });
        feedback.textContent = 'Atendimento atualizado.';
        await loadSupportRequests({ quiet: true });
      } catch (error) { feedback.textContent = error.message || 'Não foi possível salvar.'; }
      finally { save.disabled = false; }
    });
    actions.append(status, note, save);
    card.append(head, message, contact, actions, feedback);
    list.append(card);
  }
}

function releasedQuotes() {
  return (window.__cpPortalBridge?.getSavedQuotes() || []).filter((row) => row?.q?.portal?.projectId);
}

function refreshDocumentProjectOptions() {
  const select = document.getElementById('portalDocumentProject');
  if (!select) return;
  const selected = select.value;
  select.replaceChildren(new Option('Selecione o projeto', ''));
  for (const row of releasedQuotes()) {
    const option = new Option(`${row.q.client || 'Cliente'} · ${row.id}`, row.id);
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

function documentUploadPanel() {
  const panel = document.getElementById('executionPanel');
  if (!panel || document.getElementById('portalDocumentUpload')) return;
  const section = document.createElement('section');
  section.id = 'portalDocumentUpload';
  section.className = 'card portal-document-upload';
  section.innerHTML = `
    <h2>Documentos para o cliente</h2>
    <p class="hint">Envie contrato, fotos ou relatório para o projeto já liberado. O arquivo ficará privado e visível somente para o cliente associado.</p>
    <form id="portalDocumentForm">
      <label>Projeto liberado
        <select id="portalDocumentProject" required><option value="">Selecione o projeto</option></select>
      </label>
      <label>Nome que o cliente verá
        <input id="portalDocumentTitle" type="text" maxlength="120" required placeholder="Ex.: Contrato de prestação de serviços">
      </label>
      <label>Arquivo (PDF, JPG, PNG, WEBP, DOCX, XLSX ou TXT; até 15 MB)
        <input id="portalDocumentFile" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx,.txt" required>
      </label>
      <button id="portalDocumentSend" class="button primary" type="submit">Enviar e liberar no portal</button>
      <button id="refreshPortalDocumentProjects" class="button secondary" type="button">Atualizar lista de projetos</button>
      <p id="portalDocumentStatus" class="portal-sync-status" role="status" aria-live="polite"></p>
    </form>`;
  panel.append(section);
  refreshDocumentProjectOptions();
  document.getElementById('refreshPortalDocumentProjects').addEventListener('click', refreshDocumentProjectOptions);
  const fileInput = document.getElementById('portalDocumentFile');
  fileInput.addEventListener('change', () => {
    const title = document.getElementById('portalDocumentTitle');
    if (!title.value.trim() && fileInput.files?.[0]) title.value = fileInput.files[0].name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  });
  document.getElementById('portalDocumentForm').addEventListener('submit', uploadProjectDocument);
}

function documentMime(file) {
  if (file.type) return file.type.toLowerCase();
  const extension = file.name.toLowerCase().split('.').pop();
  return ({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', txt: 'text/plain' })[extension] || '';
}

async function uploadProjectDocument(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.getElementById('portalDocumentSend');
  const status = document.getElementById('portalDocumentStatus');
  const code = document.getElementById('portalDocumentProject').value;
  const file = document.getElementById('portalDocumentFile').files?.[0];
  const title = safeText(document.getElementById('portalDocumentTitle').value);
  const saved = releasedQuotes().find((row) => row.id === code);
  if (!saved || !file) return;
  const contentType = documentMime(file);
  if (!contentType) { status.textContent = 'Esse formato de arquivo não é aceito.'; status.classList.add('error'); return; }
  if (file.size <= 0 || file.size > maxDocumentBytes) { status.textContent = 'O arquivo deve ter até 15 MB.'; status.classList.add('error'); return; }
  if (!confirm(`Enviar “${file.name}” e liberar para ${saved.q.client || 'o cliente'} consultar no portal?`)) return;
  button.disabled = true;
  status.classList.remove('error');
  status.textContent = 'Preparando o envio privado…';
  try {
    if (!portalStorageClient) portalStorageClient = createClient(portalUrl, portalKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const prepared = await callFunction({ action: 'prepare_document_upload', code, title, fileName: file.name, contentType, size: file.size });
    status.textContent = 'Enviando arquivo…';
    const { error: uploadError } = await portalStorageClient.storage.from(documentBucket)
      .uploadToSignedUrl(prepared.path, prepared.token, file, { contentType });
    if (uploadError) throw uploadError;
    await callFunction({ action: 'complete_document_upload', code, title, fileName: file.name, path: prepared.path });
    status.textContent = 'Documento enviado e liberado para o cliente no portal.';
    form.reset();
    refreshDocumentProjectOptions();
  } catch (error) {
    status.textContent = error.message || 'Não foi possível enviar o documento.';
    status.classList.add('error');
  } finally {
    button.disabled = false;
  }
}

async function loadSupportRequests(options = {}) {
  const list = document.getElementById('portalSupportList');
  if (!list) return;
  const refreshButton = document.getElementById('refreshPortalSupport');
  if (!options.quiet) {
    list.textContent = 'Carregando solicitações…';
    if (refreshButton) { refreshButton.disabled = true; refreshButton.textContent = 'Atualizando…'; }
  }
  try {
    const { requests = [] } = await callSupportFunction({ action: 'support_list' });
    const token = await window.__getTeamSupportAccessToken();
    const claims = decodeSupportToken(token);
    supportSeenStorageKey = `connectplus.support.seen.${claims.sub || claims.email || portalRole || 'team'}`;
    let savedSeen = null;
    let seen = new Set();
    try {
      savedSeen = localStorage.getItem(supportSeenStorageKey);
      if (savedSeen) seen = new Set(JSON.parse(savedSeen));
    } catch { savedSeen = null; seen = new Set(); }
    if (savedSeen === null) {
      requests.forEach((request) => seen.add(String(request.id)));
      try { localStorage.setItem(supportSeenStorageKey, JSON.stringify([...seen].slice(-500))); } catch { /* no persistent notification marker */ }
    }
    supportRequestsCache = requests;
    supportUnseenIds = new Set(requests.filter((request) => !seen.has(String(request.id))).map((request) => String(request.id)));
    const openCount = requests.filter(isSupportRequestOpen).length;
    const doneCount = requests.length - openCount;
    const openCounter = document.getElementById('supportOpenCount');
    const newCounter = document.getElementById('supportNewCount');
    const doneCounter = document.getElementById('supportDoneCount');
    if (openCounter) openCounter.textContent = String(openCount);
    if (newCounter) newCounter.textContent = String(supportUnseenIds.size);
    if (doneCounter) doneCounter.textContent = String(doneCount);
    const navBadge = document.getElementById('supportOpenBadge');
    if (navBadge) {
      navBadge.textContent = String(openCount);
      navBadge.hidden = openCount < 1;
      navBadge.setAttribute('aria-label', `${openCount} solicitação(ões) em aberto`);
    }
    const toast = document.getElementById('supportTicketToast');
    if (toast) {
      toast.hidden = supportUnseenIds.size < 1;
      document.getElementById('supportTicketToastText').textContent = supportUnseenIds.size === 1
        ? 'Um cliente enviou uma solicitação de suporte.'
        : `${supportUnseenIds.size} novos chamados aguardam a equipe.`;
    }
    renderSupportRequests();
  } catch (error) {
    if (!supportRequestsCache.length || !options.quiet) list.textContent = error.message || 'Não foi possível carregar as solicitações.';
  } finally {
    if (refreshButton) { refreshButton.disabled = false; refreshButton.textContent = 'Atualizar lista'; }
  }
}

function initSupportControls() {
  if (!hasTeamSupportAccess() || supportControlsInitialized) return;
  supportControlsInitialized = true;
  supportPanel();
  loadSupportRequests();
  if (supportPollTimer) clearInterval(supportPollTimer);
  supportPollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') loadSupportRequests({ quiet: true });
  }, 45_000);
}

function mountExecutionControls() {
  const panel = document.getElementById('executionPanel');
  if (!panel || document.getElementById('publishPortalProgress')) return;
  const firstCard = panel.querySelector('.execution-work > .card');
  if (!firstCard) return;
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar no-print portal-progress-controls';
  toolbar.innerHTML = '<button id="publishPortalProgress" type="button" class="button primary">Publicar andamento no portal</button><span id="portalProgressStatus" class="save-status portal-sync-status" role="status"></span>';
  firstCard.append(toolbar);
  document.getElementById('publishPortalProgress').addEventListener('click', publishExecution);
  documentUploadPanel();
}

function bindQuoteActions() {
  const quotes = document.getElementById('savedQuotes');
  if (!quotes || quotes.dataset.portalBound) return;
  quotes.dataset.portalBound = '1';
  quoteClickHandler = (event) => {
    const button = event.target.closest('.portal-release');
    if (button) releaseProposal(button.dataset.id);
  };
  quotes.addEventListener('click', quoteClickHandler);
  quoteObserver = new MutationObserver(renderReleaseButtons);
  quoteObserver.observe(quotes, { childList: true });
  renderReleaseButtons();
}

function init() {
  if (portalControlsInitialized || !hasPortalAdminAccess() || !portalUrl || !portalKey) return;
  portalControlsInitialized = true;
  initSupportControls();
  // The portal key is publishable and can only invoke an Edge Function that
  // separately validates the logged-in internal-team JWT.
  bindQuoteActions();
  mountExecutionControls();
  const quotes = document.getElementById('savedQuotes');
  if (quotes) {
    documentProjectObserver = new MutationObserver(refreshDocumentProjectOptions);
    documentProjectObserver.observe(quotes, { childList: true, subtree: true });
  }
}

if (window.__CP_MEMBER_ROLE) setPortalRole(window.__CP_MEMBER_ROLE);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (window.__CP_MEMBER_ROLE) setPortalRole(window.__CP_MEMBER_ROLE);
  }, { once: true });
}
