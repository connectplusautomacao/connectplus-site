import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cfg = window.CONNECTPLUS_PORTAL_SYNC || {};
const portalUrl = String(cfg.url || '').replace(/\/$/, '');
const portalKey = cfg.publishableKey || '';
const actionUrl = `${portalUrl}/functions/v1/client-projects`;
const documentBucket = 'client-documents';
const maxDocumentBytes = 15 * 1024 * 1024;
const safeText = (value) => String(value ?? '').trim();
let portalStorageClient = null;

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
    'Concluída com pendências': ['Concluído com pendências', 95, 'A equipe concluiu a etapa principal e registrou pendências para acompanhamento.'],
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
  const panel = document.getElementById('executionPanel');
  if (!panel || document.getElementById('portalSupportAdmin')) return;
  const section = document.createElement('section');
  section.id = 'portalSupportAdmin';
  section.className = 'card portal-support-admin';
  section.innerHTML = '<h2>Solicitações de suporte do portal</h2><p class="hint">Pedidos enviados pelos clientes, restritos à equipe autorizada.</p><button type="button" class="button secondary" id="refreshPortalSupport">Atualizar solicitações</button><div id="portalSupportList" class="saved-list"></div>';
  panel.append(section);
  document.getElementById('refreshPortalSupport').addEventListener('click', loadSupportRequests);
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

async function loadSupportRequests() {
  const list = document.getElementById('portalSupportList');
  if (!list) return;
  list.textContent = 'Carregando solicitações…';
  try {
    const { requests = [] } = await callFunction({ action: 'support_list' });
    list.replaceChildren();
    if (!requests.length) {
      list.textContent = 'Ainda não há solicitações de suporte.';
      return;
    }
    for (const request of requests) {
      const card = document.createElement('article');
      card.className = 'support-admin-row';
      const heading = document.createElement('strong');
      heading.textContent = `${request.projects?.code || 'Projeto'} · ${request.subject}`;
      const body = document.createElement('p');
      body.textContent = request.message;
      const phone = document.createElement('p');
      phone.textContent = request.contact_phone ? `Telefone para retorno: ${request.contact_phone}` : 'Cliente não informou telefone para retorno.';
      const email = document.createElement('p');
      email.textContent = `Acesso do cliente: ${request.client_email || 'e-mail não disponível'}`;
      const status = document.createElement('select');
      for (const value of ['Recebido', 'Em análise', 'Em atendimento', 'Concluído']) {
        const option = document.createElement('option'); option.value = value; option.textContent = value; status.append(option);
      }
      status.value = request.status;
      const note = document.createElement('textarea');
      note.maxLength = 1000; note.placeholder = 'Nota interna (não aparece ao cliente)'; note.value = request.staff_note || '';
      const save = document.createElement('button');
      save.type = 'button'; save.className = 'button secondary'; save.textContent = 'Salvar atendimento';
      const feedback = document.createElement('small');
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          await callFunction({ action: 'support_update', id: request.id, status: status.value, staffNote: note.value });
          feedback.textContent = 'Atendimento atualizado.';
        } catch (error) { feedback.textContent = error.message || 'Não foi possível salvar.'; }
        finally { save.disabled = false; }
      });
      card.append(heading, body, email, phone, status, note, save, feedback);
      list.append(card);
    }
  } catch (error) {
    list.textContent = error.message || 'Não foi possível carregar as solicitações.';
  }
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
  supportPanel();
  documentUploadPanel();
}

function bindQuoteActions() {
  const quotes = document.getElementById('savedQuotes');
  if (!quotes || quotes.dataset.portalBound) return;
  quotes.dataset.portalBound = '1';
  quotes.addEventListener('click', (event) => {
    const button = event.target.closest('.portal-release');
    if (button) releaseProposal(button.dataset.id);
  });
  new MutationObserver(renderReleaseButtons).observe(quotes, { childList: true });
  renderReleaseButtons();
}

function init() {
  if (!portalUrl || !portalKey) return;
  // The portal key is publishable and can only invoke an Edge Function that
  // separately validates the logged-in internal-team JWT.
  bindQuoteActions();
  mountExecutionControls();
  const quotes = document.getElementById('savedQuotes');
  if (quotes) new MutationObserver(refreshDocumentProjectOptions).observe(quotes, { childList: true, subtree: true });
}

document.addEventListener('DOMContentLoaded', init, { once: true });
