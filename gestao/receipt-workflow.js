/* Payment tracking for the team area. The existing receipt fields and PDF remain the source document. */
let receiptSchedule = Array.isArray(db.receipt.paymentSchedule) ? db.receipt.paymentSchedule : [];
db.receipt.paymentSchedule = receiptSchedule;
for (const receipt of db.receipts) {
  if (!receipt.status) { receipt.status = 'Confirmado'; receipt.publishedStatus = 'legacy'; }
}
if (!db.receipt.status) db.receipt.status = 'Aguardando conferência';
if (db.receipt.planId === undefined) db.receipt.planId = '';

let receiptListFilter = 'all';
let receiptSearch = '';

function receiptQuote(quoteId = db.receipt.quoteId) {
  return db.savedQuotes.find((item) => item.id === quoteId) || null;
}

function receiptQuoteTotal(saved) {
  const items = saved?.q?.items || [];
  if (!items.length || items.some((item) => item.price === '' || item.price == null)) return null;
  return items.reduce((sum, item) => sum + (Number(item.qty) || 0) * (Number(item.price) || 0), 0);
}

function receiptPlanPayments(planId) {
  return db.receipts.filter((item) => item.planId === planId && item.status === 'Confirmado')
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
}

function receiptPlanStatus(plan) {
  const paid = receiptPlanPayments(plan.id);
  if (paid >= Number(plan.amount)) return 'Quitada';
  if (paid > 0) return 'Parcial';
  if (plan.dueDate && plan.dueDate < isoToday) return 'Vencida';
  return 'Pendente';
}

function receiptSummary(saved) {
  const quoteId = saved?.id;
  const total = receiptQuoteTotal(saved);
  const items = db.receipts.filter((item) => item.quoteId === quoteId);
  const received = items.filter((item) => item.status === 'Confirmado').reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const review = items.filter((item) => item.status === 'Aguardando conferência').reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  return { total, received, review, balance: total == null ? null : Math.max(0, total - received) };
}

function renderReceiptWorkflow() {
  const host = document.getElementById('receiptWorkflow');
  if (!host) return;
  const saved = receiptQuote();
  const summary = receiptSummary(saved);
  const plans = receiptSchedule.filter((item) => item.quoteId === (saved?.id || ''));
  const planOptions = plans.map((item) => `<option value="${esc(item.id)}"${item.id === db.receipt.planId ? ' selected' : ''}>${esc(item.label)} · ${money(item.amount)}</option>`).join('');
  const planRows = plans.length ? plans.map((item) => `<div class="payment-plan-row"><div><strong>${esc(item.label)}</strong><small>Vencimento ${esc(receiptDateLong(item.dueDate))} · ${money(item.amount)}</small></div><span class="payment-state ${receiptPlanStatus(item).toLowerCase()}">${receiptPlanStatus(item)}</span><button class="button ghost" type="button" data-use-payment-plan="${esc(item.id)}">Registrar recebimento</button></div>`).join('') : '<p class="receipt-muted">Selecione um orçamento para montar o cronograma de parcelas.</p>';
  const proofEnabled = Boolean(saved?.q?.portal?.projectId);
  const generatedPdfReady = window.lastReceiptPdfBlob && window.lastReceiptPdfReceiptNumber === db.receipt.number;
  host.innerHTML = `<section class="payment-summary-card"><div class="payment-heading"><div><p class="receipt-eyebrow">CONTROLE DO PROJETO</p><h3>${esc(saved?.q?.client || 'Vincule um orçamento salvo')}</h3><small>${esc(saved?.q?.number || saved?.id || 'O resumo e as parcelas aparecerão após vincular o projeto.')}</small></div><span class="payment-state ${db.receipt.status === 'Confirmado' ? 'confirmado' : db.receipt.status === 'Recusado' ? 'recusado' : 'aguardando'}">${esc(db.receipt.status)}</span></div><div class="payment-summary-grid"><div><small>Valor do projeto</small><strong>${summary.total == null ? 'A informar' : money(summary.total)}</strong></div><div><small>Recebido e confirmado</small><strong>${money(summary.received)}</strong></div><div><small>Aguardando conferência</small><strong>${money(summary.review)}</strong></div><div><small>Saldo restante</small><strong>${summary.balance == null ? 'A informar' : money(summary.balance)}</strong></div></div><label class="receipt-status-field">Conferência do pagamento<select id="receiptVerification"><option${db.receipt.status === 'Aguardando conferência' ? ' selected' : ''}>Aguardando conferência</option><option${db.receipt.status === 'Confirmado' ? ' selected' : ''}>Confirmado</option><option${db.receipt.status === 'Recusado' ? ' selected' : ''}>Recusado</option></select></label>${db.receipt.status === 'Confirmado' && db.receipt.publishedStatus !== 'Confirmado' ? '<p class="receipt-notice">Ao salvar como confirmado, o cliente vinculado será avisado pelo portal.</p>' : ''}</section><section class="payment-schedule-card"><div class="payment-heading"><div><p class="receipt-eyebrow">PLANO DE PAGAMENTO</p><h3>Parcelas do projeto</h3></div></div><div class="payment-schedule-form"><label>Parcela<input id="paymentPlanLabel" maxlength="60" placeholder="Ex.: Entrada, 2ª parcela"></label><label>Vencimento<input id="paymentPlanDate" type="date"></label><label>Valor previsto (R$)<input id="paymentPlanAmount" type="number" min="0.01" step="0.01" placeholder="0,00"></label><button class="button primary" type="button" data-add-payment-plan ${saved ? '' : 'disabled'}>Adicionar parcela</button></div><label class="payment-plan-select">Vincular este recebimento a uma parcela<select id="receiptPlanId"><option value="">Sem parcela vinculada</option>${planOptions}</select></label><div class="payment-plan-list">${planRows}</div></section><section class="payment-proof-card"><div><p class="receipt-eyebrow">COMPROVANTE DO CLIENTE</p><h3>Guardar no Portal do Cliente</h3><p class="receipt-muted">Anexe o comprovante recebido. O arquivo ficará disponível para o cliente no portal, junto às atualizações do projeto.</p></div><label>Arquivo PDF ou imagem<input id="receiptProofFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></label><div class="payment-proof-actions"><button id="sendReceiptProof" class="button secondary" type="button" ${proofEnabled ? '' : 'disabled'}>Enviar comprovante ao portal</button><button id="sendGeneratedReceipt" class="button ghost" type="button" ${proofEnabled && generatedPdfReady ? '' : 'disabled'}>Enviar PDF oficial ao cliente</button></div><p id="receiptProofStatus" class="save-status" role="status" aria-live="polite">${proofEnabled ? 'Arquivos enviados aparecem no histórico do portal e geram um aviso ao cliente.' : 'Libere primeiro este orçamento no Portal do Cliente.'}</p></section>`;
}

function renderReceiptListWithStatus() {
  const list = document.getElementById('receiptList');
  if (!list) return;
  const records = db.receipts.filter((item) => {
    const matchesFilter = receiptListFilter === 'all' || item.status === receiptListFilter;
    const query = receiptSearch.toLocaleLowerCase('pt-BR');
    return matchesFilter && (!query || `${item.client} ${item.number} ${item.quoteId} ${item.reference}`.toLocaleLowerCase('pt-BR').includes(query));
  });
  const toolbar = `<div class="receipt-list-tools"><input type="search" data-receipt-search placeholder="Buscar cliente, recibo ou proposta" value="${esc(receiptSearch)}" aria-label="Buscar comprovantes"><select data-receipt-filter aria-label="Filtrar comprovantes"><option value="all"${receiptListFilter === 'all' ? ' selected' : ''}>Todos os status</option><option${receiptListFilter === 'Aguardando conferência' ? ' selected' : ''}>Aguardando conferência</option><option${receiptListFilter === 'Confirmado' ? ' selected' : ''}>Confirmado</option><option${receiptListFilter === 'Recusado' ? ' selected' : ''}>Recusado</option></select></div>`;
  list.innerHTML = toolbar + (records.length ? records.map((item) => `<div class="saved-row"><div><b>${esc(item.client || 'Cliente')}</b><br><span>${esc(item.number)} · ${esc(item.date || '')} · ${money(item.amount || 0)} · ${esc(item.quoteId || 'Sem projeto vinculado')}</span><br><span class="payment-state ${item.status === 'Confirmado' ? 'confirmado' : item.status === 'Recusado' ? 'recusado' : 'aguardando'}">${esc(item.status || 'Aguardando conferência')}</span></div><div><button class="button ghost open-receipt" data-id="${esc(item.number)}">Abrir</button> <button class="button danger delete-receipt" data-id="${esc(item.number)}" aria-label="Remover ${esc(item.number)}">×</button></div></div>`).join('') : '<span class="receipt-muted">Nenhum comprovante corresponde a este filtro.</span>');
}

function refreshPaymentViews() {
  renderReceiptWorkflow();
  renderReceiptListWithStatus();
}

async function notifyConfirmedPayment(receipt) {
  if (receipt?.status !== 'Confirmado' || ['Confirmado', 'legacy'].includes(receipt.publishedStatus)) return false;
  if (!window.__cpPublishPaymentReceipt) throw new Error('Entre na plataforma com uma conta ativa da equipe para avisar pelo portal.');
  await window.__cpPublishPaymentReceipt(JSON.parse(JSON.stringify(receipt)));
  receipt.publishedStatus = 'Confirmado';
  receipt.publishedAt = new Date().toISOString();
  if (db.receipt.number === receipt.number) db.receipt.publishedStatus = 'Confirmado';
  persist();
  return true;
}

window.renderReceiptList = renderReceiptListWithStatus;
window.addEventListener('beforeunload', () => persist());

const receiptPanel = document.getElementById('receiptPanel');
receiptPanel.addEventListener('click', (event) => {
  const target = event.target;
  if (target.closest('#newReceipt')) {
    setTimeout(() => {
      db.receipt.status = 'Aguardando conferência';
      db.receipt.planId = '';
      db.receipt.paymentSchedule = receiptSchedule;
      db.receipt.publishedStatus = '';
      if (window.lastReceiptPdfReceiptNumber !== db.receipt.number) window.lastReceiptPdfBlob = null;
      persist(); refreshPaymentViews();
    }, 0);
  }
  if (target.id === 'saveReceipt') {
    db.receipt.status = document.getElementById('receiptVerification')?.value || db.receipt.status;
    db.receipt.planId = document.getElementById('receiptPlanId')?.value || '';
    db.receipt.quoteId = document.getElementById('receiptQuote')?.value || '';
  }
}, true);

receiptPanel.addEventListener('click', (event) => {
  const target = event.target;
  if (target.closest('[data-add-payment-plan]')) {
    const saved = receiptQuote();
    const label = document.getElementById('paymentPlanLabel').value.trim();
    const dueDate = document.getElementById('paymentPlanDate').value;
    const amount = Number(document.getElementById('paymentPlanAmount').value);
    if (!saved) { document.getElementById('receiptStatus').textContent = 'Vincule um orçamento antes de adicionar parcelas.'; return; }
    if (!label || !dueDate || !Number.isFinite(amount) || amount <= 0) { document.getElementById('receiptStatus').textContent = 'Informe o nome, vencimento e valor da parcela.'; return; }
    receiptSchedule.unshift({ id: newId(), quoteId: saved.id, label: label.slice(0, 60), dueDate, amount: Number(amount.toFixed(2)), createdAt: new Date().toISOString() });
    db.receipt.paymentSchedule = receiptSchedule;
    persist(); refreshPaymentViews();
    document.getElementById('receiptStatus').textContent = 'Parcela adicionada ao cronograma do projeto.';
    return;
  }
  const usePlan = target.closest('[data-use-payment-plan]');
  if (usePlan) {
    const plan = receiptSchedule.find((item) => item.id === usePlan.dataset.usePaymentPlan);
    if (plan) {
      db.receipt.planId = plan.id;
      db.receipt.nature = 'Parcela';
      db.receipt.amount = String(plan.amount);
      db.receipt.dueDate = plan.dueDate;
      db.receipt.referent = plan.label;
      document.getElementById('receiptAmount').value = db.receipt.amount;
      document.getElementById('receiptNature').value = db.receipt.nature;
      document.getElementById('receiptReferent').value = db.receipt.referent;
      persist(); refreshPaymentViews();
      document.getElementById('receiptStatus').textContent = 'Parcela vinculada ao novo recebimento. Confira os dados antes de salvar.';
    }
    return;
  }
  if (target.closest('#sendReceiptProof')) {
    window.__cpUploadReceiptProof?.();
  }
  if (target.closest('#sendGeneratedReceipt')) {
    window.__cpUploadGeneratedReceipt?.(window.lastReceiptPdfBlob, window.lastReceiptPdfName, JSON.parse(JSON.stringify(db.receipt)));
  }
}, true);

document.getElementById('receiptList').addEventListener('click', () => setTimeout(() => {
  db.receipt.paymentSchedule = receiptSchedule;
  persist(); refreshPaymentViews();
}, 0));

receiptPanel.addEventListener('change', (event) => {
  const target = event.target;
  if (target.id === 'receiptVerification') {
    db.receipt.status = target.value;
    persist(); refreshPaymentViews();
  }
  if (target.id === 'receiptPlanId') {
    db.receipt.planId = target.value;
    persist();
  }
  if (target.id === 'receiptQuote') {
    db.receipt.quoteId = target.value;
    db.receipt.planId = '';
    refreshPaymentViews();
  }
  if (target.matches('[data-receipt-filter]')) { receiptListFilter = target.value; renderReceiptListWithStatus(); }
});

receiptPanel.addEventListener('input', (event) => {
  if (event.target.matches('[data-receipt-search]')) {
    const cursor = event.target.selectionStart;
    receiptSearch = event.target.value;
    renderReceiptListWithStatus();
    const search = document.querySelector('[data-receipt-search]');
    search?.focus(); search?.setSelectionRange(cursor, cursor);
  }
});

receiptPanel.addEventListener('click', (event) => {
  if (!event.target.closest('#saveReceipt')) return;
  setTimeout(async () => {
    const receipt = db.receipts.find((item) => item.number === db.receipt.number);
    if (receipt) {
      delete receipt.paymentSchedule;
      receipt.status = db.receipt.status || 'Aguardando conferência';
      receipt.quoteId = db.receipt.quoteId || '';
      receipt.planId = db.receipt.planId || '';
      receipt.dueDate = db.receipt.dueDate || '';
      persist();
      if (receipt.status === 'Confirmado' && !['Confirmado', 'legacy'].includes(receipt.publishedStatus)) {
        const status = document.getElementById('receiptStatus');
        status.textContent = 'Pagamento salvo. Avisando o cliente pelo portal…';
        try {
          const sent = await notifyConfirmedPayment(receipt);
          status.textContent = sent ? 'Pagamento confirmado e cliente notificado pelo portal.' : 'Pagamento salvo.';
        } catch (error) {
          status.textContent = `Pagamento salvo, mas o aviso no portal não foi enviado: ${error.message || 'tente novamente'}.`;
        }
      }
    }
    refreshPaymentViews();
  }, 0);
});

const originalReceiptPdf = window.createReceiptPdf;
window.createReceiptPdf = async function () {
  if ((document.getElementById('receiptVerification')?.value || db.receipt.status) !== 'Confirmado') {
    throw new Error('Confirme o recebimento antes de emitir o recibo em PDF.');
  }
  const result = await originalReceiptPdf();
  const savedReceipt = db.receipts.find((item) => item.number === db.receipt.number);
  if (savedReceipt) delete savedReceipt.paymentSchedule;
  db.receipt.paymentSchedule = receiptSchedule;
  persist();
  if (savedReceipt?.status === 'Confirmado' && !['Confirmado', 'legacy'].includes(savedReceipt.publishedStatus)) {
    try { await notifyConfirmedPayment(savedReceipt); }
    catch (error) { document.getElementById('receiptStatus').textContent = `PDF gerado; o aviso no portal não foi enviado: ${error.message || 'tente novamente'}.`; }
  }
  if (window.lastReceiptPdfUrl) {
    window.lastReceiptPdfBlob = await fetch(window.lastReceiptPdfUrl).then((response) => response.blob());
    window.lastReceiptPdfName = `Recibo_ConnectPlus_${String(db.receipt.number || 'recibo').replace(/[^a-z0-9_-]/gi, '_')}.pdf`;
    window.lastReceiptPdfReceiptNumber = db.receipt.number;
    refreshPaymentViews();
  }
  return result;
};

refreshPaymentViews();
