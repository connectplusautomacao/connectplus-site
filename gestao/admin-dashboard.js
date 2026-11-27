const adminDashboardCurrency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function adminDashboardValue(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function adminDashboardDate(value) {
  if (!value) return 'Data não informada';
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('pt-BR');
}

function adminDashboardAddAlert(parent, title, detail, count, tone = '') {
  const row = document.createElement('div');
  row.className = 'admin-dashboard-alert';
  const copy = document.createElement('div');
  copy.className = 'admin-dashboard-alert-copy';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const description = document.createElement('small');
  description.textContent = detail;
  const badge = document.createElement('span');
  badge.className = `admin-dashboard-count ${tone}`.trim();
  badge.textContent = String(count);
  copy.append(heading, description);
  row.append(copy, badge);
  parent.append(row);
}

function renderAdminDashboard() {
  const root = document.getElementById('adminDashboard');
  if (!root || typeof db !== 'object') return;

  const monthInput = document.getElementById('adminDashboardMonth');
  const currentMonth = String(isoToday || new Date().toISOString().slice(0, 10)).slice(0, 7);
  if (monthInput && !monthInput.value) monthInput.value = currentMonth;
  const month = monthInput?.value || currentMonth;
  const monthDate = new Date(`${month}-01T12:00:00`);
  const monthLabel = monthDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const receipts = Array.isArray(db.receipts) ? db.receipts : [];
  const monthReceipts = receipts.filter((item) => String(item.date || '').slice(0, 7) === month);
  const confirmed = receipts.filter((item) => item.status === 'Confirmado');
  const confirmedThisMonth = monthReceipts.filter((item) => item.status === 'Confirmado');
  const receivedThisMonth = confirmedThisMonth
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const awaiting = monthReceipts.filter((item) => item.status === 'Aguardando conferência');
  const reviewTotal = awaiting.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

  const plans = Array.isArray(db.receipt?.paymentSchedule) ? db.receipt.paymentSchedule : [];
  const receivable = plans.reduce((sum, plan) => {
    const paid = confirmed.filter((item) => item.planId === plan.id)
      .reduce((total, item) => total + (Number(item.amount) || 0), 0);
    return sum + Math.max(0, (Number(plan.amount) || 0) - paid);
  }, 0);
  const openPlans = plans.filter((plan) => {
    const paid = confirmed.filter((item) => item.planId === plan.id)
      .reduce((total, item) => total + (Number(item.amount) || 0), 0);
    return paid < (Number(plan.amount) || 0);
  }).length;

  const fixedCosts = db.fixedCosts?.[month] || {};
  const fixedCostKeys = ['das', 'internet', 'maintenance', 'marketing', 'other'];
  const fixedCostTotal = fixedCostKeys.reduce((sum, key) => sum + (Number(fixedCosts[key]) || 0), 0);

  const monthProjects = (Array.isArray(db.savedQuotes) ? db.savedQuotes : [])
    .filter((saved) => db.financeRecords?.[saved.id]?.month === month)
    .map((saved) => financeCalc(saved))
    .filter((result) => result.complete && result.status !== 'Perdido');
  const estimatedProfit = monthProjects.reduce((sum, result) => sum + (Number(result.net) || 0), 0);

  adminDashboardValue('dashboardReceived', adminDashboardCurrency.format(receivedThisMonth));
  adminDashboardValue('dashboardReceivedNote', `${confirmedThisMonth.length} pagamento(s) confirmado(s) em ${monthLabel}`);
  adminDashboardValue('dashboardReceivable', adminDashboardCurrency.format(receivable));
  adminDashboardValue('dashboardReceivableNote', `${openPlans} parcela(s) em aberto no cronograma · todos os períodos`);
  adminDashboardValue('dashboardFixedCosts', adminDashboardCurrency.format(fixedCostTotal));
  adminDashboardValue('dashboardFixedCostsNote', 'Lançamentos fixos do mês selecionado');
  adminDashboardValue('dashboardEstimatedProfit', monthProjects.length ? adminDashboardCurrency.format(estimatedProfit) : 'Pendente');
  adminDashboardValue('dashboardEstimatedProfitNote', monthProjects.length
    ? `Baseado em ${monthProjects.length} projeto(s) com custos completos neste mês`
    : 'Complete os dados financeiros dos projetos para calcular');

  const openExecutions = (Array.isArray(db.savedExecutions) ? db.savedExecutions : [])
    .filter((item) => !['Concluída', 'Concluída com pendências'].includes(item.status)).length;
  const badge = document.getElementById('supportOpenBadge');
  const openSupport = Number.parseInt(badge?.textContent || '0', 10) || 0;
  const alerts = document.getElementById('adminDashboardAlerts');
  if (alerts) {
    alerts.replaceChildren();
    adminDashboardAddAlert(alerts, 'Comprovantes para conferir', `${adminDashboardCurrency.format(reviewTotal)} aguardando validação em ${monthLabel}`, awaiting.length, 'warning');
    adminDashboardAddAlert(alerts, 'Solicitações de suporte em aberto', 'Chamados aguardando atendimento da equipe', openSupport, 'blue');
    adminDashboardAddAlert(alerts, 'Ordens de serviço em andamento', 'Execuções que ainda não foram concluídas', openExecutions, 'green');
  }

  const movementHost = document.getElementById('adminDashboardMovements');
  if (movementHost) {
    movementHost.replaceChildren();
    const rows = monthReceipts.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 5);
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-dashboard-empty';
      empty.textContent = `Nenhum pagamento registrado em ${monthLabel}.`;
      movementHost.append(empty);
    } else {
      const table = document.createElement('table');
      table.className = 'admin-dashboard-table';
      table.innerHTML = '<thead><tr><th>Data</th><th>Cliente / recibo</th><th>Status</th><th>Valor</th></tr></thead>';
      const body = document.createElement('tbody');
      rows.forEach((item) => {
        const row = document.createElement('tr');
        const date = document.createElement('td');
        date.textContent = adminDashboardDate(item.date);
        const description = document.createElement('td');
        const name = document.createElement('strong');
        name.textContent = item.client || 'Cliente';
        const reference = document.createElement('small');
        reference.textContent = item.number || item.quoteId || 'Pagamento';
        description.append(name, reference);
        const status = document.createElement('td');
        status.textContent = item.status || 'Aguardando conferência';
        status.className = item.status === 'Confirmado' ? 'admin-dashboard-status confirmed' : 'admin-dashboard-status pending';
        const amount = document.createElement('td');
        amount.className = 'admin-dashboard-amount';
        amount.textContent = adminDashboardCurrency.format(Number(item.amount) || 0);
        row.append(date, description, status, amount);
        body.append(row);
      });
      table.append(body);
      movementHost.append(table);
    }
  }
}

document.getElementById('refreshAdminDashboard')?.addEventListener('click', renderAdminDashboard);
document.getElementById('adminDashboardMonth')?.addEventListener('change', renderAdminDashboard);
document.getElementById('adminDashboardManageAccess')?.addEventListener('click', () => {
  document.getElementById('companyMemberForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('companyMemberEmail')?.focus({ preventScroll: true });
});
document.getElementById('navAdmin')?.addEventListener('click', renderAdminDashboard);
document.getElementById('navAdminHome')?.addEventListener('click', renderAdminDashboard);
document.getElementById('adminDashboard')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-admin-tab]')) setTimeout(renderAdminDashboard, 0);
});
document.getElementById('supportOpenBadge') && new MutationObserver(renderAdminDashboard).observe(
  document.getElementById('supportOpenBadge'), { childList: true, subtree: true, attributes: true },
);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderAdminDashboard, { once: true });
else renderAdminDashboard();

window.renderAdminDashboard = renderAdminDashboard;
