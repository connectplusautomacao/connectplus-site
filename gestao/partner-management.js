(() => {
  const originalRenderPartners = window.renderPartners;
  const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const formatDate = (value) => {
    if (!value) return 'Sem indicação registrada';
    const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('pt-BR');
  };

  function partnerReferrals(partnerId) {
    return (Array.isArray(db.referrals) ? db.referrals : []).filter((item) => item.partnerId === partnerId);
  }

  function renderDirectory() {
    const list = document.getElementById('partnerList');
    if (!list) return;
    const partners = Array.isArray(db.partners) ? db.partners : [];
    const referrals = Array.isArray(db.referrals) ? db.referrals : [];
    const approved = referrals.filter((item) => ['Projeto aprovado', 'Concluído', 'Comissão paga'].includes(item.status));
    const commissions = referrals.reduce((sum, item) => {
      const result = typeof window.referralCalc === 'function' ? window.referralCalc(item) : null;
      return sum + (Number(result?.fee) || 0);
    }, 0);

    const metricValues = {
      partnerMetricCount: String(partners.length),
      partnerMetricReferrals: String(referrals.length),
      partnerMetricApproved: String(approved.length),
      partnerMetricCommission: currency.format(commissions),
    };
    Object.entries(metricValues).forEach(([id, value]) => {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    });

    const count = document.getElementById('partnerDirectoryCount');
    if (count) count.textContent = `${partners.length} ${partners.length === 1 ? 'parceiro' : 'parceiros'}`;

    const typeFilter = document.getElementById('partnerTypeFilter');
    const selectedType = typeFilter?.value || 'all';
    if (typeFilter) {
      const types = [...new Set(partners.map((partner) => partner.type).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
      typeFilter.replaceChildren(new Option('Todos os tipos', 'all'));
      types.forEach((type) => typeFilter.add(new Option(type, type)));
      typeFilter.value = types.includes(selectedType) ? selectedType : 'all';
    }

    const query = (document.getElementById('partnerSearch')?.value || '').trim().toLocaleLowerCase('pt-BR');
    const filtered = partners.map((partner) => ({ partner, items: partnerReferrals(partner.id) }))
      .filter(({ partner }) => typeFilter?.value === 'all' || !typeFilter?.value || partner.type === typeFilter.value)
      .filter(({ partner }) => !query || [partner.name, partner.business, partner.city, partner.email, partner.phone, partner.type]
        .some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(query)))
      .sort((a, b) => b.items.length - a.items.length || String(a.partner.name || '').localeCompare(String(b.partner.name || ''), 'pt-BR'));

    list.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'partner-directory-empty';
      empty.textContent = partners.length ? 'Nenhum parceiro encontrado com esses filtros.' : 'Sua rede ainda não tem parceiros cadastrados. Use o formulário acima para adicionar o primeiro.';
      list.append(empty);
      return;
    }

    filtered.forEach(({ partner, items }, index) => {
      const card = document.createElement('article');
      card.className = 'partner-card';

      const head = document.createElement('div');
      head.className = 'partner-card-head';
      const title = document.createElement('div');
      title.className = 'partner-card-title';
      const name = document.createElement('h3');
      name.textContent = partner.name || 'Parceiro sem nome';
      const subtitle = document.createElement('p');
      subtitle.textContent = [partner.type, partner.business].filter(Boolean).join(' · ') || 'Tipo não informado';
      title.append(name, subtitle);
      head.append(title);
      if (index === 0 && items.length > 0) {
        const rank = document.createElement('span');
        rank.className = 'partner-card-rank';
        rank.textContent = 'Mais indicações';
        head.append(rank);
      }
      card.append(head);

      const fees = items.map((item) => typeof window.referralCalc === 'function' ? window.referralCalc(item)?.fee : null)
        .filter((fee) => Number.isFinite(Number(fee))).reduce((sum, fee) => sum + Number(fee), 0);
      const lastDate = items.map((item) => item.date).filter(Boolean).sort().at(-1);
      const info = document.createElement('div');
      info.className = 'partner-card-info';
      [
        ['Indicações', String(items.length)],
        ['Percentual combinado', `${Number(partner.rate) || 0}%`],
        ['Comissão prevista', currency.format(fees)],
        ['Última indicação', formatDate(lastDate)],
      ].forEach(([label, value]) => {
        const cell = document.createElement('div');
        const caption = document.createElement('span');
        caption.textContent = label;
        const detail = document.createElement('strong');
        detail.textContent = value;
        cell.append(caption, detail);
        info.append(cell);
      });
      card.append(info);

      if (partner.city || partner.paymentCondition) {
        const detail = document.createElement('p');
        detail.className = 'partner-card-detail';
        detail.textContent = [partner.city, partner.paymentCondition ? `Pagamento: ${partner.paymentCondition}` : ''].filter(Boolean).join(' · ');
        card.append(detail);
      }

      const actions = document.createElement('div');
      actions.className = 'partner-card-contact';
      actions.style.marginTop = '10px';
      if (partner.phone) {
        const phone = document.createElement('a');
        phone.href = `tel:${String(partner.phone).replace(/[^+\d]/g, '')}`;
        phone.textContent = 'Ligar';
        actions.append(phone);
      }
      if (partner.email) {
        const email = document.createElement('a');
        email.href = `mailto:${partner.email}`;
        email.textContent = 'Enviar e-mail';
        actions.append(email);
      }
      const referral = document.createElement('button');
      referral.type = 'button';
      referral.textContent = 'Registrar indicação';
      referral.addEventListener('click', () => {
        const select = document.getElementById('refPartner');
        if (select) {
          select.value = partner.id;
          if (typeof window.onReferralPartnerChange === 'function') window.onReferralPartnerChange();
        }
        document.getElementById('referralFormCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        document.getElementById('refClient')?.focus({ preventScroll: true });
      });
      actions.append(referral);

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'edit-partner';
      edit.dataset.id = partner.id;
      edit.textContent = 'Editar';
      actions.append(edit);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger delete-partner';
      remove.dataset.id = partner.id;
      remove.textContent = 'Excluir';
      actions.append(remove);

      card.append(actions);
      list.append(card);
    });
  }

  if (typeof originalRenderPartners === 'function') {
    window.renderPartners = function renderPartnersWithDirectory(...args) {
      originalRenderPartners.apply(this, args);
      renderDirectory();
    };
    window.renderPartners();
  } else {
    renderDirectory();
  }

  document.getElementById('partnerSearch')?.addEventListener('input', renderDirectory);
  document.getElementById('partnerTypeFilter')?.addEventListener('change', renderDirectory);
  document.getElementById('partnerList')?.addEventListener('click', (event) => {
    if (event.target.closest('.edit-partner, .delete-partner')) setTimeout(renderDirectory, 0);
    if (event.target.closest('.edit-partner')) {
      document.getElementById('partnerName')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      document.getElementById('partnerName')?.focus({ preventScroll: true });
    }
  });
  document.getElementById('partnerOverviewAdd')?.addEventListener('click', () => {
    document.getElementById('partnerName')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('partnerName')?.focus({ preventScroll: true });
  });
})();
