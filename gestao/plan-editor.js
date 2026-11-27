let selectedPlanPoint = null;

const PLAN_POINT_TYPES = {
  camera: { label: 'Câmera', prefix: 'C', color: '#df4e59' },
  ap: { label: 'Access point Wi-Fi', prefix: 'AP', color: '#087fe8' },
  switch: { label: 'Interruptor inteligente', prefix: 'I', color: '#16845b' },
  sconce: { label: 'Arandela de iluminação', prefix: 'A', color: '#d78325' },
  speakerWall: { label: 'Arandela de som', prefix: 'AS', color: '#7c64cc' },
  speakerCeiling: { label: 'Caixa de som de teto', prefix: 'T', color: '#58449f' },
  light: { label: 'Ponto de iluminação', prefix: 'L', color: '#ad6700' },
};

function planRoomSize(room) {
  const scale = Math.min(45, 360 / Math.max(0.5, Number(room.w) || 1), 190 / Math.max(0.5, Number(room.h) || 1));
  return { width: Math.max(24, room.w * scale), height: Math.max(24, room.h * scale) };
}

function planPointLabel(point, index, room) {
  if (point.code) return esc(point.code);
  const type = PLAN_POINT_TYPES[point.type] || PLAN_POINT_TYPES.light;
  let count = 0; let found = false;
  for (const item of db.plan.rooms) {
    for (const itemPoint of item.points || []) {
      if (itemPoint.type === point.type) count += 1;
      if (item === room && itemPoint === point) { found = true; break; }
    }
    if (found) break;
  }
  return `${type.prefix}${count || index + 1}`;
}

function addRoom() {
  const width = Math.max(0.5, Number(document.getElementById('roomW').value) || 1);
  const height = Math.max(0.5, Number(document.getElementById('roomH').value) || 1);
  const name = document.getElementById('roomName').value.trim() || `Ambiente ${db.plan.rooms.length + 1}`;
  db.plan.rooms.push({ id: newId(), name, w: width, h: height, points: [] });
  document.getElementById('roomName').value = '';
  persist();
  renderRooms();
}

function pointCoverage(point, room, x, y, clipId) {
  const size = planRoomSize(room);
  const scale = Math.min((size.width - 24) / Math.max(0.5, Number(room.w) || 1), (size.height - 54) / Math.max(0.5, Number(room.h) || 1));
  const radius = Math.max(12, Math.min(150, (Number(point.rangeM) || 8) * scale));
  if (point.type === 'ap') {
    return `<circle pointer-events="none" cx="${x}" cy="${y}" r="${radius}" fill="#198be4" fill-opacity=".08" stroke="#1789df" stroke-opacity=".7" stroke-width="2" stroke-dasharray="7 5" clip-path="url(#${clipId})"/><circle pointer-events="none" cx="${x}" cy="${y}" r="${radius * .66}" fill="none" stroke="#1789df" stroke-opacity=".42" stroke-width="1.5" stroke-dasharray="4 5" clip-path="url(#${clipId})"/>`;
  }
  if (point.type !== 'camera') return '';
  const angle = Math.max(20, Math.min(180, Number(point.angleDeg) || 90));
  const direction = (Number(point.direction) || 0) * Math.PI / 180;
  const start = direction - angle * Math.PI / 360;
  const end = direction + angle * Math.PI / 360;
  const x1 = x + radius * Math.cos(start);
  const y1 = y + radius * Math.sin(start);
  const x2 = x + radius * Math.cos(end);
  const y2 = y + radius * Math.sin(end);
  const largeArc = angle > 180 ? 1 : 0;
  return `<path pointer-events="none" d="M${x} ${y}L${x1} ${y1}A${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}Z" fill="#e55660" fill-opacity=".16" stroke="#df4e59" stroke-opacity=".52" stroke-width="2" clip-path="url(#${clipId})"/>`;
}

function pointIcon(point, label, x, y, selected, pointIndex) {
  const type = PLAN_POINT_TYPES[point.type] || PLAN_POINT_TYPES.light;
  const klass = `plan-point${selected ? ' selected' : ''}`;
  const text = `<text x="${x + 15}" y="${y + 19}" font-size="11" font-weight="700" fill="#172b45">${label}</text>`;
  if (point.type === 'camera') return `<g class="${klass}" data-point-index="${pointIndex}"><circle cx="${x}" cy="${y}" r="14" fill="#fff" stroke="${type.color}" stroke-width="3"/><path d="M${x - 8} ${y - 5}h8l5-4v18l-5-4h-8z" fill="${type.color}"/><circle cx="${x + 7}" cy="${y}" r="2" fill="#fff"/>${text}</g>`;
  if (point.type === 'ap') return `<g class="${klass}" data-point-index="${pointIndex}"><circle cx="${x}" cy="${y}" r="14" fill="#eaf5ff" stroke="${type.color}" stroke-width="3"/><path d="M${x - 8} ${y + 2}q8-9 16 0m-12 4q4-5 8 0" fill="none" stroke="${type.color}" stroke-width="2"/><circle cx="${x}" cy="${y + 8}" r="1.5" fill="${type.color}"/>${text}</g>`;
  if (point.type === 'speakerWall') return `<g class="${klass}" data-point-index="${pointIndex}"><rect x="${x - 11}" y="${y - 15}" width="22" height="30" rx="5" fill="#f3edff" stroke="${type.color}" stroke-width="2.5"/><path d="M${x - 6} ${y - 10}v6m5-6v6m5-6v6m-10 3v2m5-2v2m5-2v2" stroke="${type.color}" stroke-width="1.5" stroke-linecap="round"/><circle cx="${x}" cy="${y + 8}" r="4" fill="none" stroke="${type.color}" stroke-width="1.7"/>${text}</g>`;
  if (point.type === 'speakerCeiling') return `<g class="${klass}" data-point-index="${pointIndex}"><circle cx="${x}" cy="${y}" r="13" fill="#f3edff" stroke="${type.color}" stroke-width="2.5"/><circle cx="${x}" cy="${y}" r="7" fill="none" stroke="${type.color}" stroke-width="1.5"/><circle cx="${x}" cy="${y}" r="2" fill="${type.color}"/>${text}</g>`;
  if (point.type === 'sconce') return `<g class="${klass}" data-point-index="${pointIndex}"><rect x="${x - 6}" y="${y - 13}" width="12" height="26" rx="5" fill="#fff0e4" stroke="${type.color}" stroke-width="2.5"/><path d="M${x - 12} ${y - 8}h4m-4 8h4m-4 8h4m12-16h4m-4 8h4m-4 8h4" stroke="${type.color}" stroke-width="2"/>${text}</g>`;
  if (point.type === 'light') return `<g class="${klass}" data-point-index="${pointIndex}"><circle cx="${x}" cy="${y}" r="13" fill="#fff5d6" stroke="#e89b17" stroke-width="3"/><path d="M${x - 6} ${y}h12m-6-6v12" stroke="#ad6700" stroke-width="2"/>${text}</g>`;
  return `<g class="${klass}" data-point-index="${pointIndex}"><rect x="${x - 11}" y="${y - 11}" width="22" height="22" rx="5" fill="#e8fbf5" stroke="${type.color}" stroke-width="3"/><path d="M${x - 5} ${y}h10m-5-5v10" stroke="${type.color}" stroke-width="2"/>${text}</g>`;
}

function renderHouseMap() {
  const house = document.getElementById('housePlan');
  if (!house) return;
  if (!db.plan.rooms.length) {
    house.innerHTML = '<div class="empty">Carregue a planta residencial padrão ou adicione os ambientes da obra.</div>';
    return;
  }
  const positions = new Map([
    ['sala de estar', 0], ['sala', 0], ['cozinha', 1], ['quarto casal', 2], ['quarto de casal', 2],
    ['quarto 2', 3], ['circulação', 4], ['circulacao', 4], ['banheiro', 5],
  ]);
  const ordered = [...db.plan.rooms].sort((a, b) => {
    const slotA = positions.get(a.name.trim().toLocaleLowerCase('pt-BR'));
    const slotB = positions.get(b.name.trim().toLocaleLowerCase('pt-BR'));
    return (slotA ?? 100 + db.plan.rooms.indexOf(a)) - (slotB ?? 100 + db.plan.rooms.indexOf(b));
  });
  const cellW = 280; const cellH = 230; const startX = 38; const startY = 44; const gap = 0;
  const rows = Math.ceil(ordered.length / 3);
  const svgHeight = startY + rows * cellH + 42;
  const roomSvg = ordered.map((room, roomIndex) => {
    room.points = Array.isArray(room.points) ? room.points : [];
    const col = roomIndex % 3; const row = Math.floor(roomIndex / 3);
    const x = startX + col * (cellW + gap); const y = startY + row * cellH;
    const inset = 14;
    const width = cellW - 2 * inset; const height = cellH - 2 * inset;
    const clipId = `plan-room-clip-${roomIndex}`;
    const points = room.points.map((point, index) => {
      const px = x + inset + 16 + point.x * (width - 32);
      const py = y + inset + 56 + point.y * (height - 72);
      const label = planPointLabel(point, index, room);
      const selected = selectedPlanPoint?.roomId === room.id && selectedPlanPoint.index === index;
      return `${pointCoverage(point, room, px, py, clipId)}${pointIcon(point, label, px, py, selected, index)}`;
    }).join('');
    return `<g class="plan-room" data-room="${esc(room.id)}"><defs><clipPath id="${clipId}"><rect x="${x + inset}" y="${y + inset + 44}" width="${width}" height="${height - 44}" rx="2"/></clipPath></defs><rect class="house-room-hit" data-room-id="${esc(room.id)}" x="${x}" y="${y}" width="${cellW}" height="${cellH}" fill="#fff" stroke="#142a45" stroke-width="8"/><rect class="room-hit" data-room-id="${esc(room.id)}" x="${x + inset}" y="${y + inset + 44}" width="${width}" height="${height - 44}" fill="#f8fbff" fill-opacity=".8" stroke="none"/><text x="${x + cellW / 2}" y="${y + 29}" text-anchor="middle" font-size="15" font-weight="700" fill="#152c49">${esc(room.name)}</text><text x="${x + cellW / 2}" y="${y + 43}" text-anchor="middle" font-size="11" fill="#5d7189">${esc(room.w)} × ${esc(room.h)} m</text>${points}</g>`;
  }).join('');
  const windowMarks = ordered.length >= 3 ? `<g stroke="#10a8c8" stroke-width="5"><path d="M120 44h58M400 44h58M680 44h58M38 120v54M878 112v56"/></g>` : '';
  house.innerHTML = `<svg class="house-plan-svg" viewBox="0 0 888 ${svgHeight}" role="img" aria-label="Planta residencial editável com ${ordered.length} ambientes"><rect x="${startX}" y="${startY}" width="${cellW * 3}" height="${rows * cellH}" rx="4" fill="#fff" stroke="#142a45" stroke-width="8"/>${roomSvg}${windowMarks}<text x="${startX}" y="${svgHeight - 12}" font-size="11" fill="#657891">Esquema editável · medidas informadas pelo técnico · pontos e coberturas ilustrativas</text></svg>`;
}

function pointTypeOptions(value) {
  return Object.entries(PLAN_POINT_TYPES).map(([key, type]) => `<option value="${key}"${key === value ? ' selected' : ''}>${type.label}</option>`).join('');
}

function renderSelectedPointEditor() {
  const target = document.getElementById('selectedPointEditor');
  if (!target) return;
  const room = selectedPlanPoint && db.plan.rooms.find((item) => item.id === selectedPlanPoint.roomId);
  const point = room?.points?.[selectedPlanPoint.index];
  if (!room || !point) { target.innerHTML = ''; return; }
  const type = PLAN_POINT_TYPES[point.type] || PLAN_POINT_TYPES.light;
  const coverageFields = ['camera', 'ap'].includes(point.type)
    ? `<label>Alcance ilustrativo (m)<input data-point-field="rangeM" type="number" min="0.5" max="50" step="0.5" value="${esc(point.rangeM ?? 8)}"></label>${point.type === 'camera' ? `<label>Abertura da câmera (°)<input data-point-field="angleDeg" type="number" min="20" max="180" step="5" value="${esc(point.angleDeg ?? 90)}"></label><label>Direção<select data-point-field="direction"><option value="0"${Number(point.direction ?? 0) === 0 ? ' selected' : ''}>Direita</option><option value="90"${Number(point.direction) === 90 ? ' selected' : ''}>Baixo</option><option value="180"${Number(point.direction) === 180 ? ' selected' : ''}>Esquerda</option><option value="270"${Number(point.direction) === 270 ? ' selected' : ''}>Cima</option></select></label>` : ''}`
    : '';
  target.innerHTML = `<div class="point-editor"><div class="items-head"><div><h3>Detalhes do ponto</h3><p class="hint">${type.label} · ${esc(room.name)}</p></div><button type="button" class="button ghost" data-close-point>Fechar</button></div><div class="point-editor-grid"><label>Equipamento<select data-point-field="type">${pointTypeOptions(point.type)}</select></label><label>Identificação<input data-point-field="code" maxlength="16" value="${esc(point.code || planPointLabel(point, selectedPlanPoint.index, room))}"></label>${coverageFields}<label class="point-notes">Observações para a equipe<textarea data-point-field="notes" rows="2" maxlength="500" placeholder="Ex.: voltada para a entrada; instalada a 2,4 m; parede norte">${esc(point.notes || '')}</textarea></label><div class="point-editor-actions"><button type="button" class="button primary" data-save-point="${esc(room.id)}:${selectedPlanPoint.index}">Salvar detalhes</button><button type="button" class="button danger" data-remove-selected>Remover ponto</button></div></div>${point.type === 'camera' || point.type === 'ap' ? '<p class="footnote">Alcance de câmera e Wi-Fi são estimativas visuais. Paredes e condições do local podem alterar a cobertura real.</p>' : ''}</div>`;
}

function renderRooms() {
  const grid = document.getElementById('roomGrid');
  const status = document.getElementById('planEditStatus');
  if (!db.plan.rooms.length) {
    selectedPlanPoint = null;
    grid.innerHTML = '<div class="empty">Adicione um ambiente para começar a planta residencial.</div>';
    document.getElementById('planPrint').innerHTML = '<div class="empty">Nenhum ambiente cadastrado.</div>';
    renderHouseMap();
    renderSelectedPointEditor();
    if (status) status.textContent = 'Adicione ambientes ou carregue uma planta residencial inicial.';
    return;
  }

  grid.innerHTML = db.plan.rooms.map((room) => {
    room.points = Array.isArray(room.points) ? room.points : [];
    const chips = room.points.length
      ? room.points.map((point, index) => {
        const type = PLAN_POINT_TYPES[point.type] || PLAN_POINT_TYPES.light;
        const selected = selectedPlanPoint?.roomId === room.id && selectedPlanPoint.index === index;
        return `<button type="button" class="point-chip${selected ? ' selected' : ''}" data-select-point="${esc(room.id)}:${index}">${type.label} · ${esc(planPointLabel(point, index, room))}</button>`;
      }).join('')
      : '<span class="hint">Nenhum ponto neste cômodo.</span>';
    return `<article class="room-card"><div class="room-card-head"><h3>${esc(room.name)}</h3><button type="button" class="button danger remove-room" data-id="${esc(room.id)}">Remover cômodo</button></div><div class="room-dims">${esc(room.w)} m × ${esc(room.h)} m · ${room.points.length} ponto(s)</div><div class="room-editor"><label>Nome do cômodo<input data-room-field="name" data-room-id="${esc(room.id)}" value="${esc(room.name)}" maxlength="70"></label><label>Largura (m)<input data-room-field="w" data-room-id="${esc(room.id)}" type="number" min="0.5" max="100" step="0.1" value="${esc(room.w)}"></label><label>Comprimento (m)<input data-room-field="h" data-room-id="${esc(room.id)}" type="number" min="0.5" max="100" step="0.1" value="${esc(room.h)}"></label><button type="button" class="button ghost save-room" data-save-room="${esc(room.id)}">Salvar cômodo</button></div><div class="point-list">${chips}</div></article>`;
  }).join('');

  renderHouseMap();
  renderSelectedPointEditor();
  const printMap = document.getElementById('housePlan')?.innerHTML || '';
  const printRooms = grid.cloneNode(true);
  printRooms.querySelectorAll('.room-editor,.remove-room,.point-chip').forEach((element) => element.remove());
  document.getElementById('planPrint').innerHTML = `<div class="plan-print-head"><h1>${esc(db.plan.name || 'Planta técnica ConnectPlus')}</h1><div>${esc(db.plan.address || '')}</div><div class="legend">Câmera: campo de visão · Access point: cobertura Wi-Fi · A: arandela de luz · AS: arandela de som · T: caixa de som de teto · L: iluminação · I: interruptor</div></div>${printMap}<div class="room-grid">${printRooms.innerHTML}</div>`;

  if (status) {
    status.textContent = db.plan.mode === 'move'
      ? selectedPlanPoint ? 'Ponto selecionado. Toque no novo local dentro do mesmo cômodo.' : 'Toque no ponto e depois escolha o novo local no mesmo cômodo.'
      : db.plan.mode
        ? `Clique dentro de um cômodo para adicionar ${PLAN_POINT_TYPES[db.plan.mode]?.label || 'um ponto'}.`
        : 'Edite os cômodos abaixo. Selecione um ponto para registrar alcance, direção e observações.';
  }

  const map = document.getElementById('housePlan');
  map?.querySelectorAll('.plan-room').forEach((roomGroup) => {
    roomGroup.addEventListener('click', (event) => {
      const hit = event.target.closest('.room-hit');
      const room = db.plan.rooms.find((item) => item.id === roomGroup.dataset.room);
      if (!room) return;
      const marker = event.target.closest('[data-point-index]');
      if (db.plan.mode === 'move') {
        if (marker) {
          selectedPlanPoint = { roomId: room.id, index: Number(marker.dataset.pointIndex) };
          renderRooms();
          return;
        }
        if (!selectedPlanPoint) return;
        if (!hit) return;
        if (selectedPlanPoint.roomId !== room.id) {
          if (status) status.textContent = 'Para manter a planta correta, reposicione o ponto dentro do mesmo cômodo.';
          return;
        }
        const box = hit.getBoundingClientRect();
        const point = room.points[selectedPlanPoint.index];
        if (!point) { selectedPlanPoint = null; return; }
        point.x = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
        point.y = Math.max(0, Math.min(1, (event.clientY - box.top) / box.height));
        persist(); renderRooms(); return;
      }
      if (marker) {
        selectedPlanPoint = { roomId: room.id, index: Number(marker.dataset.pointIndex) };
        renderRooms();
        return;
      }
      if (!db.plan.mode) return;
      if (!hit) return;
      const box = hit.getBoundingClientRect();
      const point = { type: db.plan.mode, x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) };
      if (['camera', 'ap'].includes(point.type)) point.rangeM = 8;
      if (point.type === 'camera') { point.angleDeg = 90; point.direction = 0; }
      const type = PLAN_POINT_TYPES[point.type] || PLAN_POINT_TYPES.light;
      const nextCount = db.plan.rooms.flatMap((item) => item.points || []).filter((item) => item.type === point.type).length + 1;
      point.code = `${type.prefix}${nextCount}`;
      room.points.push(point);
      selectedPlanPoint = { roomId: room.id, index: room.points.length - 1 };
      persist(); renderRooms();
    });
  });
}

document.getElementById('roomGrid').addEventListener('click', (event) => {
  const saveButton = event.target.closest('[data-save-room]');
  if (!saveButton) return;
  const room = db.plan.rooms.find((item) => item.id === saveButton.dataset.saveRoom);
  if (!room) return;
  const fields = [...document.querySelectorAll(`[data-room-id="${CSS.escape(room.id)}"][data-room-field]`)];
  const values = Object.fromEntries(fields.map((field) => [field.dataset.roomField, field.value.trim()]));
  const width = Number(values.w); const height = Number(values.h);
  if (!values.name || !Number.isFinite(width) || !Number.isFinite(height) || width < 0.5 || height < 0.5 || width > 100 || height > 100) {
    if (document.getElementById('planEditStatus')) document.getElementById('planEditStatus').textContent = 'Informe um nome e medidas entre 0,5 m e 100 m.';
    return;
  }
  room.name = values.name.slice(0, 70); room.w = width; room.h = height;
  persist(); renderRooms();
});

document.getElementById('roomGrid').addEventListener('click', (event) => {
  const select = event.target.closest('[data-select-point]');
  const remove = event.target.closest('[data-remove-point]');
  if (remove) {
    const [roomId, index] = remove.dataset.removePoint.split(':');
    const room = db.plan.rooms.find((item) => item.id === roomId);
    if (room) { room.points.splice(Number(index), 1); selectedPlanPoint = null; persist(); renderRooms(); }
    return;
  }
  if (select) {
    const [roomId, index] = select.dataset.selectPoint.split(':');
    selectedPlanPoint = { roomId, index: Number(index) };
    renderRooms();
  }
});

document.getElementById('selectedPointEditor').addEventListener('click', (event) => {
  if (event.target.closest('[data-close-point]')) { selectedPlanPoint = null; renderRooms(); return; }
  if (event.target.closest('[data-remove-selected]') && selectedPlanPoint) {
    const room = db.plan.rooms.find((item) => item.id === selectedPlanPoint.roomId);
    if (room) room.points.splice(selectedPlanPoint.index, 1);
    selectedPlanPoint = null; persist(); renderRooms(); return;
  }
  const button = event.target.closest('[data-save-point]');
  if (!button || !selectedPlanPoint) return;
  const room = db.plan.rooms.find((item) => item.id === selectedPlanPoint.roomId);
  const point = room?.points?.[selectedPlanPoint.index];
  if (!point) return;
  const values = Object.fromEntries([...document.querySelectorAll('#selectedPointEditor [data-point-field]')].map((field) => [field.dataset.pointField, field.value.trim()]));
  const status = document.getElementById('planEditStatus');
  if (values.rangeM && (!Number.isFinite(Number(values.rangeM)) || Number(values.rangeM) < 0.5 || Number(values.rangeM) > 50)) {
    if (status) status.textContent = 'Informe um alcance entre 0,5 m e 50 m.';
    return;
  }
  if (values.angleDeg && (!Number.isFinite(Number(values.angleDeg)) || Number(values.angleDeg) < 20 || Number(values.angleDeg) > 180)) {
    if (status) status.textContent = 'Informe uma abertura entre 20° e 180°.';
    return;
  }
  point.type = values.type || point.type;
  point.code = (values.code || `${PLAN_POINT_TYPES[point.type]?.prefix || 'P'}1`).slice(0, 16);
  point.notes = (values.notes || '').slice(0, 500);
  if (values.rangeM) point.rangeM = Number(values.rangeM);
  if (values.angleDeg) point.angleDeg = Number(values.angleDeg);
  if (values.direction !== undefined) point.direction = Number(values.direction);
  if (['camera', 'ap'].includes(point.type) && !point.rangeM) point.rangeM = 8;
  if (point.type === 'camera' && !point.angleDeg) { point.angleDeg = 90; point.direction = 0; }
  persist(); renderRooms();
  if (status) status.textContent = `Detalhes de ${point.code} salvos na planta.`;
});

document.getElementById('modeBar').addEventListener('click', (event) => {
  if (!event.target.closest('[data-mode]')) return;
  if (db.plan.mode !== 'move') selectedPlanPoint = null;
  renderRooms();
});

renderRooms();
