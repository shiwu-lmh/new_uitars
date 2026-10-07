const state = { people: [], filtered: [], page: 1, pageSize: 3, selected: null, expanded: new Set() };
const byId = (id) => document.getElementById(id);
const riskRank = { 紧急: 4, 高: 3, 中: 2, 低: 1 };
const testMode = new URLSearchParams(window.location.search).get('test');
// The daily local demo uses the expanded dataset by default. The URL modes remain
// available so a test can explicitly select long-only or multi-record behavior.
const multiRecordMode = !testMode || testMode === 'multi-records';
const longRecordTest = testMode === 'long-record' || multiRecordMode;

function filters() {
  return { query: byId('search-input').value.trim().toLowerCase(), department: byId('department-filter').value, status: byId('status-filter').value, from: byId('from-date').value, to: byId('to-date').value, sort: byId('sort-filter').value };
}

function applyFilters(resetPage = true) {
  const f = filters();
  state.filtered = state.people.filter((person) => {
    const queryOk = !f.query || person.name.toLowerCase().includes(f.query) || person.patient_id.toLowerCase().includes(f.query);
    const dateOk = (!f.from || person.last_updated >= f.from) && (!f.to || person.last_updated <= f.to);
    return queryOk && (!f.department || person.department === f.department) && (!f.status || person.status === f.status) && dateOk;
  });
  state.filtered.sort((a, b) => f.sort === 'name-asc' ? a.name.localeCompare(b.name, 'zh-CN') : f.sort === 'risk-desc' ? riskRank[b.risk] - riskRank[a.risk] : b.last_updated.localeCompare(a.last_updated));
  if (resetPage) state.page = 1;
  renderResults();
}

function renderResults() {
  const results = byId('results'); results.replaceChildren();
  const start = (state.page - 1) * state.pageSize; const visible = state.filtered.slice(start, start + state.pageSize);
  byId('result-summary').textContent = `共 ${state.filtered.length} 人 · 每页 ${state.pageSize} 人`;
  byId('page-info').textContent = `${state.filtered.length ? state.page : 0} / ${Math.max(1, Math.ceil(state.filtered.length / state.pageSize))}`;
  byId('prev-page').disabled = state.page <= 1; byId('next-page').disabled = start + state.pageSize >= state.filtered.length;
  if (!visible.length) { results.textContent = '没有符合条件的演示数据。'; return; }
  visible.forEach((person) => {
    const card = document.createElement('article'); card.className = 'result-card';
    card.innerHTML = `<div><h3>${person.name}</h3><p class="meta">${person.patient_id} · ${person.department} · ${person.records.length} 份记录</p><p class="meta">出生日期：${person.birth_date} · 更新：${person.last_updated}</p></div>`;
    const side = document.createElement('div'); side.className = 'card-side'; const badge = document.createElement('span');
    badge.className = `badge ${person.status === '已归档' ? 'muted' : person.risk === '高' ? 'danger' : ''}`; badge.textContent = `${person.status} / 风险${person.risk}`;
    const openDetails = () => showDetails(person);
    card.setAttribute('role', 'button'); card.tabIndex = 0; card.addEventListener('click', openDetails);
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetails(); } });
    const button = document.createElement('button'); button.textContent = '进入病历'; button.addEventListener('click', (event) => { event.stopPropagation(); openDetails(); });
    side.append(badge, button); card.append(side); results.append(card);
  });
}

function showDetails(person) {
  state.selected = person; state.expanded.clear(); const details = byId('details'); details.replaceChildren(); details.classList.remove('hidden');
  const back = document.createElement('button'); back.className = 'secondary back'; back.textContent = '← 返回列表'; back.addEventListener('click', () => details.classList.add('hidden'));
  const banner = document.createElement('p'); banner.className = 'demo-banner'; banner.textContent = '本地虚构数据：请核对患者身份并截取全部病历内容。';
  const title = document.createElement('h2'); title.textContent = `${person.name}（${person.patient_id}）`;
  const identity = document.createElement('div'); identity.className = 'identity-grid'; identity.innerHTML = `<span>出生日期<strong>${person.birth_date}</strong></span><span>科室<strong>${person.department}</strong></span><span>状态<strong>${person.status}</strong></span><span>风险<strong>${person.risk}</strong></span><span>更新时间<strong>${person.last_updated}</strong></span>`;
  const controls = document.createElement('div'); controls.className = 'detail-actions'; const recordList = document.createElement('div'); recordList.className = 'record-list';
  const expand = document.createElement('button'); expand.textContent = '展开全部记录'; expand.addEventListener('click', () => { person.records.forEach((record) => state.expanded.add(record.record_id)); renderRecords(person, recordList); });
  const collapse = document.createElement('button'); collapse.className = 'secondary'; collapse.textContent = '收起全部记录'; collapse.addEventListener('click', () => { state.expanded.clear(); renderRecords(person, recordList); });
  controls.append(expand, collapse); renderRecords(person, recordList);
  const bottomBack = document.createElement('button'); bottomBack.className = 'secondary back'; bottomBack.textContent = '← 返回列表'; bottomBack.addEventListener('click', () => details.classList.add('hidden'));
  details.append(back, banner, title, identity, controls, recordList, bottomBack); details.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderRecords(person, container) {
  container.replaceChildren(); person.records.forEach((record) => {
    const card = document.createElement('details'); card.className = 'record-card'; card.open = state.expanded.has(record.record_id); card.addEventListener('toggle', () => card.open ? state.expanded.add(record.record_id) : state.expanded.delete(record.record_id));
    const summary = document.createElement('summary'); summary.innerHTML = `<strong>${record.title}</strong><span>${record.type} · ${record.date} · ${record.record_id} · 优先级${record.priority}</span>`;
    card.append(summary); record.sections.forEach((section) => { const p = document.createElement('p'); p.textContent = section; card.append(p); }); container.append(card);
  });
}

byId('login-form').addEventListener('submit', (event) => { event.preventDefault(); const valid = byId('username').value === 'demo' && byId('password').value === 'demo'; byId('login-error').textContent = valid ? '' : '演示账号或密码错误。'; if (valid) { byId('login-panel').classList.add('hidden'); byId('app-panel').classList.remove('hidden'); applyFilters(); } });
byId('search-button').addEventListener('click', () => applyFilters());
byId('reset-button').addEventListener('click', () => { ['search-input', 'from-date', 'to-date'].forEach((id) => { byId(id).value = ''; }); byId('department-filter').value = ''; byId('status-filter').value = ''; applyFilters(); });
byId('prev-page').addEventListener('click', () => { if (state.page > 1) { state.page -= 1; renderResults(); } });
byId('next-page').addEventListener('click', () => { if (state.page * state.pageSize < state.filtered.length) { state.page += 1; renderResults(); } });
byId('logout-button').addEventListener('click', () => window.location.reload());
fetch('data.json').then((response) => response.json()).then((people) => {
  if (longRecordTest) {
    const target = people.find((person) => person.patient_id === 'DEMO-001');
    const record = target?.records.find((item) => item.record_id === 'REC-001-C');
    if (record) {
      record.sections = Array.from({ length: 60 }, (_, index) =>
        `长病历分页测试第 ${index + 1} 段：这是本地虚构内容，用于验证滚动截图、断点恢复和 OCR。`
      );
    }
    if (multiRecordMode && target) {
      const extraRecords = Array.from({ length: 7 }, (_, index) => {
        const number = String(index + 1).padStart(2, '0');
        const isLong = index === 0;
        return {
          record_id: `REC-001-T${number}`,
          type: index % 2 === 0 ? '复诊' : '随访',
          title: `多页测试病历 ${number}`,
          date: `2026-10-${String(index + 2).padStart(2, '0')}`,
          priority: index === 0 ? '重点' : '常规',
          sections: isLong
            ? Array.from({ length: 42 }, (_, sectionIndex) =>
              `多病历分页测试记录 ${number} · 第 ${sectionIndex + 1} 段：这是本地虚构内容，用于验证多份病历连续滚动、分页截图和 OCR。`
            )
            : [
              `多病历测试记录 ${number}，用于验证病历数量增加后的连续处理。`,
              '本条内容仅用于本地演示，不代表真实医疗意见。',
              '截图完成后应继续处理下一份记录。',
            ],
        };
      });
      target.records.push(...extraRecords);
    }
  }
  state.people = people;
  [...new Set(people.map((person) => person.department))].sort().forEach((department) => { const option = document.createElement('option'); option.value = department; option.textContent = department; byId('department-filter').append(option); });
}).catch(() => { byId('login-error').textContent = '演示数据加载失败，请确认使用了启动脚本。'; });
