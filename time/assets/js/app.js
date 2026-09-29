(() => {
  'use strict';

  const API = {
    projects: 'api/projects.php',
    entries: 'api/entries.php',
    settings: 'api/settings.php',
    dbConfig: 'db-setup.php',
    dbConfigApi: 'api/db-config.php',
    phpHello: 'hello.php',
  };

  const PHP_NOT_RUNNING_MSG =
    'PHP is not executing under /time (nginx returned PHP source). In CloudPanel add scripts/nginx-time-php.snippet.conf under Sites → cloudmosaic.ai → Vhost/Nginx, or run scripts/enable-php-for-time.sh as root — then open hello.php and Recheck.';

  const state = {
    settings: {},
    projects: [],
    enterRows: [],
    historyEntries: [],
    dayHoursOutside: {},
    weekHoursOutside: {},
  };

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // --- Utilities ---

  function looksLikePhpSource(text) {
    const trimmed = (text || '').trim();
    return trimmed.startsWith('<?php') || trimmed.startsWith('<?PHP') || trimmed.startsWith('<?=');
  }

  async function api(url, options = {}) {
    const opts = { ...options };
    opts.headers = {
      Accept: 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    };
    const res = await fetch(url, opts);
    const text = await res.text();
    if (looksLikePhpSource(text)) {
      throw new Error(PHP_NOT_RUNNING_MSG);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Invalid server response (HTTP ${res.status})`);
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function $(sel, root = document) {
    return root.querySelector(sel);
  }

  function $$(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function toast(message, type = 'success') {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast ${type}`;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      el.classList.add('hidden');
    }, 3200);
  }

  function parseDate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function addDays(dateStr, n) {
    const d = parseDate(dateStr);
    d.setDate(d.getDate() + n);
    return formatDate(d);
  }

  function todayLocal() {
    return formatDate(new Date());
  }

  function weekStartDay() {
    return parseInt(state.settings.week_start_day ?? '1', 10);
  }

  function getWeekRange(anchorDateStr) {
    const d = parseDate(anchorDateStr || todayLocal());
    const startDow = weekStartDay();
    const current = d.getDay();
    let diff = current - startDow;
    if (diff < 0) diff += 7;
    d.setDate(d.getDate() - diff);
    const from = formatDate(d);
    const rangeDays = parseInt(state.settings.default_range_days ?? '7', 10);
    const to = addDays(from, Math.max(1, rangeDays) - 1);
    return { from, to };
  }

  function eachDate(from, to) {
    const dates = [];
    let cur = from;
    while (cur <= to) {
      dates.push(cur);
      cur = addDays(cur, 1);
    }
    return dates;
  }

  function includeWeekends() {
    return state.settings.include_weekends !== '0';
  }

  function isWeekend(dateStr) {
    const day = parseDate(dateStr).getDay();
    return day === 0 || day === 6;
  }

  function workDates(from, to) {
    const dates = eachDate(from, to);
    if (includeWeekends()) return dates;
    return dates.filter((d) => !isWeekend(d));
  }

  function hourStep() {
    return parseFloat(state.settings.hour_increment ?? '0.25');
  }

  function maxHours() {
    return parseFloat(state.settings.max_hours_per_day ?? '8');
  }

  function maxHoursWeek() {
    return parseFloat(state.settings.max_hours_per_week ?? '40');
  }

  function weekKeyForDate(dateStr) {
    // Full 7-day calendar week for grouping / capacity (independent of default_range_days)
    const d = parseDate(dateStr);
    const startDow = weekStartDay();
    const current = d.getDay();
    let diff = current - startDow;
    if (diff < 0) diff += 7;
    d.setDate(d.getDate() - diff);
    const from = formatDate(d);
    const to = addDays(from, 6);
    return { key: `${from}|${to}`, from, to };
  }

  function selectedProjectIds(selectEl) {
    return Array.from(selectEl.selectedOptions).map((o) => parseInt(o.value, 10));
  }

  function projectById(id) {
    return state.projects.find((p) => p.id === id);
  }

  function openModal(id) {
    const el = $(id);
    el.classList.remove('hidden');
    el.setAttribute('aria-hidden', 'false');
  }

  function closeModal(el) {
    const modal = el.closest('.modal') || el;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  // --- Tabs ---

  function switchTab(name) {
    $$('.tab').forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.panel').forEach((panel) => {
      const on = panel.id === `panel-${name}`;
      panel.hidden = !on;
      panel.classList.toggle('active', on);
    });
    if (name === 'history') refreshHistory();
    if (name === 'projects') renderProjectsTable();
    if (name === 'settings') {
      fillSettingsForm();
      loadDbConfigForm();
    }
  }

  // --- Projects select helpers ---

  function fillProjectSelects() {
    const active = state.projects.filter((p) => p.is_active);
    const all = state.projects;

    function fill(select, list, keepSelection = true) {
      const prev = keepSelection ? selectedProjectIds(select) : [];
      select.innerHTML = '';
      list.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.code ? `${p.name} (${p.code})` : p.name;
        if (prev.includes(p.id)) opt.selected = true;
        select.appendChild(opt);
      });
    }

    fill($('#enter-projects'), active);
    fill($('#history-projects'), all);
    fill($('#entry-project'), all, false);
  }

  // --- Enter Time ---

  function setEnterRange(from, to) {
    $('#enter-from').value = from;
    $('#enter-to').value = to;
  }

  function applyThisWeek(target) {
    const range = getWeekRange(todayLocal());
    if (target === 'enter') setEnterRange(range.from, range.to);
    else {
      $('#history-from').value = range.from;
      $('#history-to').value = range.to;
    }
  }

  function shiftWeek(which, deltaWeeks) {
    const fromEl = which === 'enter' ? $('#enter-from') : $('#history-from');
    const toEl = which === 'enter' ? $('#enter-to') : $('#history-to');
    const from = fromEl.value || todayLocal();
    const days = eachDate(fromEl.value || from, toEl.value || from).length || 7;
    const newFrom = addDays(from, deltaWeeks * 7);
    const newTo = addDays(newFrom, days - 1);
    fromEl.value = newFrom;
    toEl.value = newTo;
    if (which === 'enter') loadEnterGrid(false);
    else refreshHistory();
  }

  async function loadEnterGrid(showToast = true) {
    const from = $('#enter-from').value;
    const to = $('#enter-to').value;
    const ids = selectedProjectIds($('#enter-projects'));

    if (!from || !to) {
      toast('Select a date range', 'error');
      return;
    }
    if (from > to) {
      toast('From date must be before To date', 'error');
      return;
    }
    if (!ids.length) {
      toast('Select at least one project', 'error');
      return;
    }

    const allowFuture = state.settings.allow_future_dates === '1';
    const today = todayLocal();
    if (!allowFuture && from > today) {
      toast('Future dates are not allowed in settings', 'error');
      return;
    }

    let existing = {};
    state.dayHoursOutside = {};
    state.weekHoursOutside = {};
    try {
      const data = await api(
        `${API.entries}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&project_ids=${ids.join(',')}`
      );
      data.entries.forEach((e) => {
        existing[`${e.project_id}|${e.work_date}`] = e;
      });

      const selected = new Set(ids);
      const gridDateList = workDates(from, to).filter((d) => allowFuture || d <= today);
      const gridDateSet = new Set(gridDateList);
      const weekSpans = {};
      gridDateList.forEach((d) => {
        const wk = weekKeyForDate(d);
        weekSpans[wk.key] = wk;
      });

      for (const wk of Object.values(weekSpans)) {
        const weekData = await api(
          `${API.entries}?from=${encodeURIComponent(wk.from)}&to=${encodeURIComponent(wk.to)}`
        );
        let baseWeek = 0;
        weekData.entries.forEach((e) => {
          const replacedByGrid = selected.has(e.project_id) && gridDateSet.has(e.work_date);
          if (replacedByGrid) return;
          baseWeek += e.hours;
          if (gridDateSet.has(e.work_date)) {
            state.dayHoursOutside[e.work_date] =
              (state.dayHoursOutside[e.work_date] || 0) + e.hours;
          }
        });
        state.weekHoursOutside[wk.key] = baseWeek;
      }
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    const dates = workDates(from, to).filter((d) => allowFuture || d <= today);
    const rows = [];
    ids.forEach((pid) => {
      const project = projectById(pid);
      if (!project) return;
      dates.forEach((date) => {
        const key = `${pid}|${date}`;
        const ex = existing[key];
        rows.push({
          project_id: pid,
          project_name: project.name,
          project_color: project.color,
          work_date: date,
          hours: ex ? String(ex.hours) : '',
          notes: ex ? (ex.notes || '') : '',
          entry_id: ex ? ex.id : null,
        });
      });
    });

    state.enterRows = rows;
    renderEnterGrid();
    if (showToast) toast(`Loaded ${rows.length} row${rows.length === 1 ? '' : 's'}`);
  }

  function renderEnterGrid() {
    const tbody = $('#enter-tbody');
    tbody.innerHTML = '';

    if (!state.enterRows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Select a date range and one or more projects, then click Load grid.</td></tr>';
      $('#enter-summary').hidden = true;
      return;
    }

    const step = hourStep();
    const max = maxHours();

    state.enterRows.forEach((row, idx) => {
      const tr = document.createElement('tr');
      const day = DAY_NAMES[parseDate(row.work_date).getDay()];
      tr.innerHTML = `
        <td class="sticky-project">
          <span class="project-swatch" style="background:${row.project_color}"></span>
          ${escapeHtml(row.project_name)}
        </td>
        <td>${row.work_date}</td>
        <td>${day}</td>
        <td class="col-hours">
          <input type="number" class="hours-input" data-idx="${idx}" min="0" max="${max}" step="${step}" value="${row.hours}" inputmode="decimal">
        </td>
        <td>
          <input type="text" class="notes-input" data-idx="${idx}" maxlength="500" value="${escapeAttr(row.notes)}" placeholder="Optional">
        </td>
      `;
      tbody.appendChild(tr);
    });

    $$('.hours-input', tbody).forEach((input) => {
      input.addEventListener('input', onEnterHoursChange);
      input.addEventListener('change', onEnterHoursChange);
      input.addEventListener('keyup', onEnterHoursChange);
    });
    $$('.notes-input', tbody).forEach((input) => {
      input.addEventListener('input', (e) => {
        const i = parseInt(e.target.dataset.idx, 10);
        state.enterRows[i].notes = e.target.value;
      });
    });

    $('#enter-summary').hidden = false;
    updateEnterTotals();
  }

  function syncEnterRowsFromDom() {
    $$('#enter-tbody .hours-input').forEach((input) => {
      const i = parseInt(input.dataset.idx, 10);
      if (state.enterRows[i]) {
        state.enterRows[i].hours = input.value;
      }
    });
    $$('#enter-tbody .notes-input').forEach((input) => {
      const i = parseInt(input.dataset.idx, 10);
      if (state.enterRows[i]) {
        state.enterRows[i].notes = input.value;
      }
    });
  }

  function onEnterHoursChange(e) {
    const i = parseInt(e.target.dataset.idx, 10);
    if (state.enterRows[i]) {
      state.enterRows[i].hours = e.target.value;
    }
    updateEnterTotals();
  }

  function updateEnterTotals() {
    syncEnterRowsFromDom();

    const dayTotals = {};
    const projectTotals = {};
    let grand = 0;
    const datesInGrid = [];

    state.enterRows.forEach((row) => {
      if (!datesInGrid.includes(row.work_date)) datesInGrid.push(row.work_date);
      const h = parseFloat(row.hours);
      if (!h || h <= 0 || Number.isNaN(h)) return;
      grand += h;
      dayTotals[row.work_date] = (dayTotals[row.work_date] || 0) + h;
      if (!projectTotals[row.project_id]) {
        projectTotals[row.project_id] = {
          name: row.project_name,
          color: row.project_color,
          hours: 0,
        };
      }
      projectTotals[row.project_id].hours += h;
    });
    datesInGrid.sort();

    const maxDay = maxHours();
    const maxWeek = maxHoursWeek();

    // Day capacity cards — always list every day in the grid so left hours stay visible live
    const dayHint = $('#enter-day-hint');
    if (!datesInGrid.length) {
      dayHint.innerHTML = '<span class="muted">No hours entered yet</span>';
    } else {
      dayHint.innerHTML = datesInGrid
        .map((d) => {
          const gridH = dayTotals[d] || 0;
          const outside = state.dayHoursOutside[d] || 0;
          const claimed = gridH + outside;
          const left = Math.max(0, maxDay - claimed);
          const over = claimed > maxDay + 0.001;
          const dayName = DAY_NAMES[parseDate(d).getDay()].slice(0, 3);
          const cls = over ? 'capacity-pill is-over' : left < 0.001 ? 'capacity-pill is-full' : 'capacity-pill';
          const outsideNote =
            outside > 0.001
              ? `<span class="pill-sub">(+${outside.toFixed(2)} other)</span>`
              : '';
          return `<div class="${cls}" title="${d}">
            <span class="pill-label">${dayName} ${d.slice(5)}</span>
            <span class="pill-claimed">${claimed.toFixed(2)} claimed</span>
            <span class="pill-left">${over ? `over by ${(claimed - maxDay).toFixed(2)}` : `${left.toFixed(2)} left`}</span>
            ${outsideNote}
          </div>`;
        })
        .join('');
    }

    // Project live breakdown
    const projectHint = $('#enter-project-hint');
    const projectIds = Object.keys(projectTotals);
    if (!projectIds.length) {
      projectHint.innerHTML = '<span class="muted">Projects: no hours yet</span>';
    } else {
      projectHint.innerHTML = projectIds
        .map((pid) => {
          const p = projectTotals[pid];
          return `<span class="chip"><span class="chip-dot" style="background:${p.color}"></span>${escapeHtml(p.name)}: ${p.hours.toFixed(2)}h</span>`;
        })
        .join('');
    }

    // Week capacity
    const weekBuckets = {};
    datesInGrid.forEach((d) => {
      const wk = weekKeyForDate(d);
      if (!weekBuckets[wk.key]) {
        weekBuckets[wk.key] = { ...wk, grid: 0 };
      }
      weekBuckets[wk.key].grid += dayTotals[d] || 0;
    });

    const weekEl = $('#enter-week-capacity');
    const weekKeys = Object.keys(weekBuckets).sort();
    if (!weekKeys.length) {
      weekEl.innerHTML = `<div class="capacity-pill week-pill total-pill">
        <span class="pill-label">Total</span>
        <span class="pill-claimed">${grand.toFixed(2)} h</span>
      </div>`;
    } else {
      weekEl.innerHTML =
        `<div class="capacity-pill week-pill total-pill">
          <span class="pill-label">Total</span>
          <span class="pill-claimed">${grand.toFixed(2)} h</span>
        </div>` +
        weekKeys
          .map((key) => {
            const b = weekBuckets[key];
            const outside = state.weekHoursOutside[key] || 0;
            const claimed = b.grid + outside;
            const left = Math.max(0, maxWeek - claimed);
            const over = claimed > maxWeek + 0.001;
            const cls = over
              ? 'capacity-pill week-pill is-over'
              : left < 0.001
                ? 'capacity-pill week-pill is-full'
                : 'capacity-pill week-pill';
            return `<div class="${cls}">
              <span class="pill-label">Week ${b.from.slice(5)} → ${b.to.slice(5)}</span>
              <span class="pill-claimed">${claimed.toFixed(2)} / ${maxWeek.toFixed(2)} h</span>
              <span class="pill-left">${over ? `over by ${(claimed - maxWeek).toFixed(2)}` : `${left.toFixed(2)} left`}</span>
            </div>`;
          })
          .join('');
    }

    $$('.hours-input').forEach((input) => {
      const i = parseInt(input.dataset.idx, 10);
      const row = state.enterRows[i];
      if (!row) return;
      const claimed = (dayTotals[row.work_date] || 0) + (state.dayHoursOutside[row.work_date] || 0);
      input.classList.toggle('is-invalid', claimed > maxDay + 0.001);
    });
  }

  async function saveEnterGrid() {
    if (!state.enterRows.length) {
      toast('Load a grid first', 'error');
      return;
    }

    syncEnterRowsFromDom();

    const requireNotes = state.settings.require_notes === '1';
    const max = maxHours();
    const maxWeek = maxHoursWeek();
    const step = hourStep();
    const allowFuture = state.settings.allow_future_dates === '1';
    const today = todayLocal();
    const dayTotals = {};
    const entries = [];

    for (const row of state.enterRows) {
      const raw = String(row.hours).trim();
      if (raw === '') {
        entries.push({
          project_id: row.project_id,
          work_date: row.work_date,
          hours: 0,
          notes: row.notes || '',
        });
        continue;
      }
      const hours = parseFloat(raw);
      if (Number.isNaN(hours) || hours < 0) {
        toast(`Invalid hours on ${row.work_date}`, 'error');
        return;
      }
      if (hours > 0) {
        if (hours > max) {
          toast(`Hours on ${row.work_date} exceed max (${max})`, 'error');
          return;
        }
        if (step > 0) {
          const scaled = Math.round(hours / step);
          if (Math.abs(hours - scaled * step) > 0.001) {
            toast(`Hours must use ${step} increments`, 'error');
            return;
          }
        }
        if (requireNotes && !(row.notes || '').trim()) {
          toast(`Notes required for ${row.project_name} on ${row.work_date}`, 'error');
          return;
        }
        if (!allowFuture && row.work_date > today) {
          toast(`Future date not allowed: ${row.work_date}`, 'error');
          return;
        }
        dayTotals[row.work_date] = (dayTotals[row.work_date] || 0) + hours;
      }
      entries.push({
        project_id: row.project_id,
        work_date: row.work_date,
        hours: hours || 0,
        notes: row.notes || '',
      });
    }

    for (const d of Object.keys(dayTotals)) {
      const claimed = dayTotals[d] + (state.dayHoursOutside[d] || 0);
      if (claimed > max + 0.001) {
        toast(`Day ${d}: ${claimed.toFixed(2)}h claimed exceeds max ${max}`, 'error');
        return;
      }
    }

    const weekBuckets = {};
    Object.keys(dayTotals).forEach((d) => {
      const wk = weekKeyForDate(d);
      if (!weekBuckets[wk.key]) weekBuckets[wk.key] = { ...wk, grid: 0 };
      weekBuckets[wk.key].grid += dayTotals[d];
    });
    for (const key of Object.keys(weekBuckets)) {
      const claimed = weekBuckets[key].grid + (state.weekHoursOutside[key] || 0);
      if (claimed > maxWeek + 0.001) {
        toast(
          `Week ${weekBuckets[key].from} → ${weekBuckets[key].to}: ${claimed.toFixed(2)}h exceeds max ${maxWeek}`,
          'error'
        );
        return;
      }
    }

    const btn = $('#enter-save');
    btn.disabled = true;
    try {
      const data = await api(API.entries, {
        method: 'POST',
        body: JSON.stringify({ entries, clear_zeros: true }),
      });
      toast(`Saved ${data.saved} entr${data.saved === 1 ? 'y' : 'ies'}`);
      await loadEnterGrid(false);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // --- History ---

  async function refreshHistory() {
    const from = $('#history-from').value;
    const to = $('#history-to').value;
    if (!from || !to) return;
    if (from > to) {
      toast('From date must be before To date', 'error');
      return;
    }

    const ids = selectedProjectIds($('#history-projects'));
    let url = `${API.entries}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    if (ids.length) url += `&project_ids=${ids.join(',')}`;

    try {
      const data = await api(url);
      state.historyEntries = data.entries;
      renderHistory(data.summary);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderHistory(summary) {
    const tbody = $('#history-tbody');
    tbody.innerHTML = '';

    $('#history-total').textContent = `${(summary.total_hours || 0).toFixed(2)} h total`;
    const chips = $('#history-chips');
    chips.innerHTML = '';
    (summary.by_project || []).forEach((p) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `<span class="chip-dot" style="background:${p.project_color}"></span>${escapeHtml(p.project_name)}: ${Number(p.hours).toFixed(2)}h`;
      chips.appendChild(chip);
    });

    if (!state.historyEntries.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No entries in this range.</td></tr>';
      return;
    }

    let lastWeek = null;
    state.historyEntries.forEach((entry) => {
      const wk = weekKeyForDate(entry.work_date);
      if (wk.key !== lastWeek) {
        lastWeek = wk.key;
        const header = document.createElement('tr');
        header.className = 'week-group-header';
        header.innerHTML = `<td colspan="5">Week ${wk.from} → ${wk.to}</td>`;
        tbody.appendChild(header);
      }

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${entry.work_date}</td>
        <td>
          <span class="project-swatch" style="background:${entry.project_color}"></span>
          ${escapeHtml(entry.project_name)}
        </td>
        <td class="col-hours">${Number(entry.hours).toFixed(2)}</td>
        <td>${escapeHtml(entry.notes || '')}</td>
        <td class="col-actions">
          <div class="action-row">
            <button type="button" class="btn btn-secondary btn-sm" data-action="edit-entry" data-id="${entry.id}" title="Edit">Edit</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="load-entry" data-id="${entry.id}" title="Open week in Enter Time">Enter</button>
            <button type="button" class="btn btn-danger btn-sm" data-action="delete-entry" data-id="${entry.id}" title="Delete">Del</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  function findHistoryEntry(id) {
    return state.historyEntries.find((e) => e.id === id);
  }

  function openEntryEditor(id) {
    const entry = findHistoryEntry(id);
    if (!entry) return;
    fillProjectSelects();
    $('#entry-id').value = entry.id;
    $('#entry-project').value = entry.project_id;
    $('#entry-date').value = entry.work_date;
    $('#entry-hours').value = entry.hours;
    $('#entry-hours').step = hourStep();
    $('#entry-hours').max = maxHours();
    $('#entry-notes').value = entry.notes || '';
    openModal('#entry-modal');
  }

  async function updateEntry(e) {
    e.preventDefault();
    const id = parseInt($('#entry-id').value, 10);
    const payload = {
      id,
      project_id: parseInt($('#entry-project').value, 10),
      work_date: $('#entry-date').value,
      hours: parseFloat($('#entry-hours').value),
      notes: $('#entry-notes').value,
    };
    try {
      await api(API.entries, { method: 'PUT', body: JSON.stringify(payload) });
      closeModal($('#entry-modal'));
      toast('Entry updated');
      await refreshHistory();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function deleteEntry(id) {
    if (!confirm('Delete this time entry?')) return;
    try {
      await api(`${API.entries}?id=${id}`, { method: 'DELETE' });
      toast('Entry deleted');
      await refreshHistory();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function deleteHistoryRange() {
    const from = $('#history-from').value;
    const to = $('#history-to').value;
    if (!from || !to) return;
    const ids = selectedProjectIds($('#history-projects'));
    const scope = ids.length ? 'selected projects in this range' : 'all entries in this range';
    if (!confirm(`Delete ${scope}? This cannot be undone.`)) return;

    let url = `${API.entries}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    if (ids.length) url += `&project_ids=${ids.join(',')}`;
    try {
      const data = await api(url, { method: 'DELETE' });
      toast(`Deleted ${data.deleted} entr${data.deleted === 1 ? 'y' : 'ies'}`);
      await refreshHistory();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function loadEntryIntoEnter(id) {
    const entry = findHistoryEntry(id);
    if (!entry) return;
    const range = getWeekRange(entry.work_date);
    setEnterRange(range.from, range.to);
    const select = $('#enter-projects');
    $$('option', select).forEach((opt) => {
      opt.selected = parseInt(opt.value, 10) === entry.project_id;
    });
    // Also select any other projects that have entries that week for convenience
    try {
      const data = await api(
        `${API.entries}?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
      );
      const pids = new Set(data.entries.map((e) => e.project_id));
      pids.add(entry.project_id);
      $$('option', select).forEach((opt) => {
        opt.selected = pids.has(parseInt(opt.value, 10));
      });
    } catch (_) {
      /* ignore */
    }
    switchTab('enter');
    await loadEnterGrid(false);
    toast('Loaded week into Enter Time');
  }

  // --- Projects CRUD ---

  function renderProjectsTable() {
    const tbody = $('#projects-tbody');
    tbody.innerHTML = '';
    if (!state.projects.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No projects yet. Add one to get started.</td></tr>';
      return;
    }
    state.projects.forEach((p) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="project-swatch" style="background:${p.color}"></span></td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.code || '—')}</td>
        <td><span class="status-pill ${p.is_active ? 'active' : 'inactive'}">${p.is_active ? 'Active' : 'Inactive'}</span></td>
        <td>${p.sort_order}</td>
        <td class="col-actions">
          <div class="action-row">
            <button type="button" class="btn btn-secondary btn-sm" data-action="edit-project" data-id="${p.id}">Edit</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="toggle-project" data-id="${p.id}">${p.is_active ? 'Deactivate' : 'Activate'}</button>
            <button type="button" class="btn btn-danger btn-sm" data-action="delete-project" data-id="${p.id}">Delete</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  function openProjectModal(project) {
    $('#project-modal-title').textContent = project ? 'Edit project' : 'Add project';
    $('#project-id').value = project ? project.id : '';
    $('#project-name').value = project ? project.name : '';
    $('#project-code').value = project ? (project.code || '') : '';
    $('#project-color').value = project ? project.color : '#3d5a80';
    $('#project-sort').value = project ? project.sort_order : 0;
    $('#project-active').checked = project ? !!project.is_active : true;
    openModal('#project-modal');
  }

  async function saveProject(e) {
    e.preventDefault();
    const id = $('#project-id').value;
    const payload = {
      name: $('#project-name').value.trim(),
      code: $('#project-code').value.trim(),
      color: $('#project-color').value,
      sort_order: parseInt($('#project-sort').value, 10) || 0,
      is_active: $('#project-active').checked ? 1 : 0,
    };
    try {
      if (id) {
        payload.id = parseInt(id, 10);
        await api(API.projects, { method: 'PUT', body: JSON.stringify(payload) });
        toast('Project updated');
      } else {
        await api(API.projects, { method: 'POST', body: JSON.stringify(payload) });
        toast('Project added');
      }
      closeModal($('#project-modal'));
      await loadProjects();
      renderProjectsTable();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function toggleProject(id) {
    const p = projectById(id);
    if (!p) return;
    try {
      await api(API.projects, {
        method: 'PUT',
        body: JSON.stringify({ id, is_active: p.is_active ? 0 : 1 }),
      });
      toast(p.is_active ? 'Project deactivated' : 'Project activated');
      await loadProjects();
      renderProjectsTable();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function deleteProject(id) {
    const p = projectById(id);
    if (!p) return;
    if (!confirm(`Delete project "${p.name}"? If it has entries it will be deactivated instead.`)) return;
    try {
      const data = await api(`${API.projects}?id=${id}`, { method: 'DELETE' });
      toast(data.soft_deleted ? 'Project deactivated (has entries)' : 'Project deleted');
      await loadProjects();
      renderProjectsTable();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function loadProjects() {
    const data = await api(API.projects);
    state.projects = data.projects;
    fillProjectSelects();
  }

  // --- Settings ---

  function fillSettingsForm() {
    const s = state.settings;
    $('#set-week-start').value = s.week_start_day ?? '1';
    $('#set-max-hours').value = s.max_hours_per_day ?? '8';
    $('#set-max-week').value = s.max_hours_per_week ?? '40';
    $('#set-increment').value = s.hour_increment ?? '0.25';
    $('#set-range-days').value = s.default_range_days ?? '7';
    $('#set-timezone').value = s.timezone ?? 'America/New_York';
    $('#set-include-weekends').checked = s.include_weekends !== '0';
    $('#set-require-notes').checked = s.require_notes === '1';
    $('#set-allow-future').checked = s.allow_future_dates === '1';
  }

  async function loadSettings() {
    const data = await api(API.settings);
    state.settings = data.settings;
  }

  async function saveSettings(e) {
    e.preventDefault();
    const settings = {
      week_start_day: $('#set-week-start').value,
      max_hours_per_day: $('#set-max-hours').value,
      max_hours_per_week: $('#set-max-week').value,
      hour_increment: $('#set-increment').value,
      default_range_days: $('#set-range-days').value,
      timezone: $('#set-timezone').value.trim() || 'America/New_York',
      include_weekends: $('#set-include-weekends').checked ? '1' : '0',
      require_notes: $('#set-require-notes').checked ? '1' : '0',
      allow_future_dates: $('#set-allow-future').checked ? '1' : '0',
    };
    try {
      const data = await api(API.settings, {
        method: 'PUT',
        body: JSON.stringify({ settings }),
      });
      state.settings = data.settings;
      toast('Settings saved');
      applyThisWeek('enter');
      applyThisWeek('history');
      if (state.enterRows.length) {
        await loadEnterGrid(false);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // --- Database credentials UI ---

  async function parseJsonResponse(res) {
    const text = await res.text();
    if (looksLikePhpSource(text)) {
      const err = new Error(PHP_NOT_RUNNING_MSG);
      err.code = 'PHP_NOT_RUNNING';
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(
        `API did not return JSON (HTTP ${res.status}). Response: ${text.slice(0, 120)}`
      );
    }
  }

  async function checkPhpHealth() {
    const res = await fetch(`${API.phpHello}?_=${Date.now()}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    const text = await res.text();
    if (looksLikePhpSource(text)) {
      return { ok: false, code: 'PHP_NOT_RUNNING', raw: text.slice(0, 80) };
    }
    try {
      const data = JSON.parse(text);
      if (data && data.ok) {
        return {
          ok: true,
          php: data.php,
          mysqli: !!data.mysqli,
          message: data.message || 'PHP is running',
        };
      }
      return { ok: false, code: 'PHP_BAD_RESPONSE', raw: text.slice(0, 120) };
    } catch (e) {
      return { ok: false, code: 'PHP_BAD_RESPONSE', raw: text.slice(0, 120) };
    }
  }

  function showPhpSetupOverlay(detail) {
    const overlay = $('#php-setup-overlay');
    const errEl = $('#php-setup-error');
    if (errEl) {
      if (detail && detail.raw) {
        errEl.textContent = `Server returned: ${detail.raw}`;
        errEl.hidden = false;
      } else {
        errEl.hidden = true;
      }
    }
    hideDbSetupOverlay();
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
  }

  function hidePhpSetupOverlay() {
    const overlay = $('#php-setup-overlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
  }

  async function fetchDbConfig() {
    const res = await fetch(API.dbConfig, { headers: { Accept: 'application/json' } });
    const data = await parseJsonResponse(res);
    if (!data || data.ok === false) {
      throw new Error((data && data.error) || 'Could not load DB config');
    }
    return data;
  }

  function setDbStatus(el, data) {
    if (!el) return;
    if (data.connected) {
      el.textContent = data.tables_ready
        ? `Connected to ${data.config.db} @ ${data.config.host}`
        : `Connected, but tables missing — check “Create / update tables”`;
      el.className = 'hint db-status is-ok';
    } else {
      el.textContent = data.error
        ? `Not connected: ${data.error}`
        : 'Not connected';
      el.className = 'hint db-status is-bad';
    }
  }

  async function loadDbConfigForm() {
    try {
      const data = await fetchDbConfig();
      $('#db-host').value = data.config.host || 'localhost';
      $('#db-name').value = data.config.db || '';
      $('#db-user').value = data.config.user || '';
      $('#db-pass').value = '';
      $('#db-pass').placeholder = data.config.has_password
        ? 'Leave blank to keep current password'
        : 'Database password';
      setDbStatus($('#db-status'), data);
    } catch (err) {
      const el = $('#db-status');
      el.textContent = err.message;
      el.className = 'hint db-status is-bad';
    }
  }

  function readDbForm(prefix) {
    return {
      host: $(`#${prefix}host`).value.trim(),
      db: $(`#${prefix}name`).value.trim(),
      user: $(`#${prefix}user`).value.trim(),
      pass: $(`#${prefix}pass`).value,
    };
  }

  async function postDbConfig(payload) {
    const action = payload.test_only ? 'test' : 'save';
    const body = {
      action,
      host: payload.host,
      db: payload.db,
      user: payload.user,
    };
    if (payload.pass != null && payload.pass !== '') body.pass = payload.pass;
    if (payload.keep_password) body.keep_password = '1';
    if (payload.install_schema) body.install_schema = '1';
    if (payload.test_only) body.test_only = '1';

    // Prefer POST so passwords are not written to nginx access logs (GET query strings are).
    let res = await fetch(API.dbConfig, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    // Fallback for hosts that block POST to PHP: GET without preferring it first.
    if (res.status === 405 || res.status === 501) {
      const params = new URLSearchParams();
      Object.entries(body).forEach(([k, v]) => {
        if (v != null && v !== '') params.set(k, String(v));
      });
      res = await fetch(`${API.dbConfig}?${params.toString()}`, {
        headers: { Accept: 'application/json' },
      });
    }

    const data = await parseJsonResponse(res);
    if (!res.ok || data.ok === false) {
      throw new Error((data && data.error) || 'Save failed');
    }
    return data;
  }

  async function testDbFromSettings() {
    const form = readDbForm('db-');
    try {
      await postDbConfig({
        ...form,
        keep_password: form.pass === '',
        test_only: true,
      });
      toast('Connection successful');
      $('#db-status').textContent = `Test OK — ${form.db} @ ${form.host}`;
      $('#db-status').className = 'hint db-status is-ok';
    } catch (err) {
      toast(err.message, 'error');
      $('#db-status').textContent = err.message;
      $('#db-status').className = 'hint db-status is-bad';
    }
  }

  async function saveDbFromSettings() {
    const form = readDbForm('db-');
    try {
      const data = await postDbConfig({
        ...form,
        keep_password: form.pass === '',
        install_schema: $('#db-install-schema').checked,
      });
      toast(data.message || 'Database credentials saved');
      setDbStatus($('#db-status'), data);
      $('#db-pass').value = '';
      $('#db-pass').placeholder = 'Leave blank to keep current password';
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function showDbSetupOverlay(prefill) {
    const overlay = $('#db-setup-overlay');
    if (prefill && prefill.config) {
      $('#setup-db-host').value = prefill.config.host || 'localhost';
      $('#setup-db-name').value = prefill.config.db || '';
      $('#setup-db-user').value = prefill.config.user || '';
    }
    $('#db-setup-error').hidden = true;
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
  }

  function hideDbSetupOverlay() {
    const overlay = $('#db-setup-overlay');
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
  }

  async function testDbFromSetup() {
    const form = {
      host: $('#setup-db-host').value.trim(),
      db: $('#setup-db-name').value.trim(),
      user: $('#setup-db-user').value.trim(),
      pass: $('#setup-db-pass').value,
    };
    const errEl = $('#db-setup-error');
    try {
      await postDbConfig({ ...form, test_only: true });
      errEl.hidden = true;
      toast('Connection successful');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  }

  async function saveDbFromSetup(e) {
    e.preventDefault();
    const form = {
      host: $('#setup-db-host').value.trim(),
      db: $('#setup-db-name').value.trim(),
      user: $('#setup-db-user').value.trim(),
      pass: $('#setup-db-pass').value,
    };
    const errEl = $('#db-setup-error');
    try {
      const data = await postDbConfig({
        ...form,
        install_schema: $('#setup-db-install').checked,
      });
      hideDbSetupOverlay();
      toast(data.message || 'Database saved');
      window.location.reload();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  }

  // --- Excel CSV import / export ---

  const EXPORT_HEADERS = ['work_date', 'project_code', 'project_name', 'hours', 'notes'];

  function csvEscape(value) {
    const s = value == null ? '' : String(value);
    if (/[",\r\n]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function downloadTextFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function exportHistoryExcel() {
    const from = $('#history-from').value;
    const to = $('#history-to').value;
    if (!from || !to) {
      toast('Select a date range first', 'error');
      return;
    }
    if (from > to) {
      toast('From date must be before To date', 'error');
      return;
    }

    const ids = selectedProjectIds($('#history-projects'));
    let url = `${API.entries}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    if (ids.length) url += `&project_ids=${ids.join(',')}`;

    try {
      const data = await api(url);
      const rows = [EXPORT_HEADERS.join(',')];
      data.entries.forEach((e) => {
        const project = projectById(e.project_id);
        const code = e.project_code || (project && project.code) || '';
        rows.push(
          [
            csvEscape(e.work_date),
            csvEscape(code),
            csvEscape(e.project_name),
            csvEscape(Number(e.hours).toFixed(2)),
            csvEscape(e.notes || ''),
          ].join(',')
        );
      });

      // UTF-8 BOM so Excel opens accented text correctly
      const csv = `\uFEFF${rows.join('\r\n')}\r\n`;
      downloadTextFile(
        `timetracking_${from}_${to}.csv`,
        csv,
        'text/csv;charset=utf-8'
      );
      toast(`Exported ${data.entries.length} row${data.entries.length === 1 ? '' : 's'}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const cleaned = text.replace(/^\uFEFF/, '');

    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];
      const next = cleaned[i + 1];
      if (inQuotes) {
        if (ch === '"' && next === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (ch === '\r') {
        // ignore; handle on \n
      } else {
        field += ch;
      }
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }

  function normalizeHeader(h) {
    return String(h || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');
  }

  function excelSerialToDate(serial) {
    const n = Number(serial);
    if (!Number.isFinite(n) || n < 20000) return null;
    // Excel serial date (days since 1899-12-30)
    const utc = Date.UTC(1899, 11, 30) + Math.round(n) * 86400000;
    const d = new Date(utc);
    return formatDate(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  function normalizeImportDate(raw) {
    const s = String(raw || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // MM/DD/YYYY or M/D/YYYY
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    }
    const serial = excelSerialToDate(s);
    if (serial) return serial;
    return null;
  }

  function resolveImportProject(code, name) {
    const codeNorm = String(code || '').trim().toLowerCase();
    const nameNorm = String(name || '').trim().toLowerCase();
    if (codeNorm) {
      const byCode = state.projects.find(
        (p) => (p.code || '').trim().toLowerCase() === codeNorm
      );
      if (byCode) return byCode;
    }
    if (nameNorm) {
      const byName = state.projects.find(
        (p) => p.name.trim().toLowerCase() === nameNorm
      );
      if (byName) return byName;
    }
    return null;
  }

  async function importHistoryExcel(file) {
    if (!file) return;
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      toast('Please save as CSV in Excel (File → Save As → CSV UTF-8), then import that file.', 'error');
      return;
    }

    let text;
    try {
      text = await file.text();
    } catch (err) {
      toast('Could not read file', 'error');
      return;
    }

    const rows = parseCsv(text);
    if (rows.length < 2) {
      toast('CSV has no data rows', 'error');
      return;
    }

    const headers = rows[0].map(normalizeHeader);
    const idx = {
      work_date: headers.indexOf('work_date'),
      project_code: headers.indexOf('project_code'),
      project_name: headers.indexOf('project_name'),
      hours: headers.indexOf('hours'),
      notes: headers.indexOf('notes'),
    };

    // Allow alternate header labels Excel users might type
    if (idx.work_date < 0) idx.work_date = headers.indexOf('date');
    if (idx.project_name < 0) idx.project_name = headers.indexOf('project');
    if (idx.hours < 0) idx.hours = headers.findIndex((h) => h === 'hour' || h === 'hrs');

    if (idx.work_date < 0 || idx.hours < 0 || (idx.project_code < 0 && idx.project_name < 0)) {
      toast('CSV must include work_date, hours, and project_code or project_name columns', 'error');
      return;
    }

    const entries = [];
    const errors = [];
    for (let r = 1; r < rows.length; r++) {
      const cols = rows[r];
      const workDate = normalizeImportDate(cols[idx.work_date]);
      const hours = parseFloat(cols[idx.hours]);
      const code = idx.project_code >= 0 ? cols[idx.project_code] : '';
      const pname = idx.project_name >= 0 ? cols[idx.project_name] : '';
      const notes = idx.notes >= 0 ? String(cols[idx.notes] || '').trim() : '';

      if (!workDate) {
        errors.push(`Row ${r + 1}: invalid date`);
        continue;
      }
      if (!Number.isFinite(hours) || hours < 0) {
        errors.push(`Row ${r + 1}: invalid hours`);
        continue;
      }
      if (hours === 0) continue;

      const project = resolveImportProject(code, pname);
      if (!project) {
        errors.push(`Row ${r + 1}: unknown project "${code || pname}"`);
        continue;
      }

      entries.push({
        project_id: project.id,
        work_date: workDate,
        hours,
        notes,
      });
    }

    if (!entries.length) {
      toast(errors.length ? errors.slice(0, 3).join('; ') : 'No valid rows to import', 'error');
      return;
    }

    const confirmMsg = errors.length
      ? `Import ${entries.length} row(s)? ${errors.length} row(s) will be skipped.`
      : `Import ${entries.length} row(s)? Existing matching project+date entries will be updated.`;
    if (!confirm(confirmMsg)) return;

    try {
      const data = await api(API.entries, {
        method: 'POST',
        body: JSON.stringify({ entries, clear_zeros: false }),
      });
      toast(`Imported ${data.saved} entr${data.saved === 1 ? 'y' : 'ies'}`);
      await loadProjects();
      await refreshHistory();
      if (state.enterRows.length) {
        await loadEnterGrid(false);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // --- Escape helpers ---

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, '&#39;');
  }

  // --- Event wiring ---

  function bindEvents() {
    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    $('#enter-this-week').addEventListener('click', () => {
      applyThisWeek('enter');
      loadEnterGrid(false);
    });
    $('#enter-prev-week').addEventListener('click', () => shiftWeek('enter', -1));
    $('#enter-next-week').addEventListener('click', () => shiftWeek('enter', 1));
    $('#enter-load').addEventListener('click', () => loadEnterGrid(true));
    $('#enter-save').addEventListener('click', saveEnterGrid);

    $('#history-this-week').addEventListener('click', () => {
      applyThisWeek('history');
      refreshHistory();
    });
    $('#history-prev-week').addEventListener('click', () => shiftWeek('history', -1));
    $('#history-next-week').addEventListener('click', () => shiftWeek('history', 1));
    $('#history-refresh').addEventListener('click', refreshHistory);
    $('#history-export').addEventListener('click', exportHistoryExcel);
    $('#history-import').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      await importHistoryExcel(file);
    });
    $('#history-delete-range').addEventListener('click', deleteHistoryRange);

    $('#history-tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = parseInt(btn.dataset.id, 10);
      if (btn.dataset.action === 'edit-entry') openEntryEditor(id);
      if (btn.dataset.action === 'delete-entry') deleteEntry(id);
      if (btn.dataset.action === 'load-entry') loadEntryIntoEnter(id);
    });

    $('#project-add').addEventListener('click', () => openProjectModal(null));
    $('#project-form').addEventListener('submit', saveProject);
    $('#projects-tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = parseInt(btn.dataset.id, 10);
      if (btn.dataset.action === 'edit-project') openProjectModal(projectById(id));
      if (btn.dataset.action === 'toggle-project') toggleProject(id);
      if (btn.dataset.action === 'delete-project') deleteProject(id);
    });

    $('#settings-save').addEventListener('click', saveSettings);
    $('#settings-form').addEventListener('submit', saveSettings);
    $('#entry-form').addEventListener('submit', updateEntry);
    $('#db-test').addEventListener('click', testDbFromSettings);
    $('#db-save').addEventListener('click', saveDbFromSettings);
    $('#db-form').addEventListener('submit', (e) => {
      e.preventDefault();
      saveDbFromSettings();
    });
    $('#setup-db-test').addEventListener('click', testDbFromSetup);
    $('#db-setup-form').addEventListener('submit', saveDbFromSetup);
    const recheckBtn = $('#php-setup-recheck');
    if (recheckBtn) {
      recheckBtn.addEventListener('click', async () => {
        recheckBtn.disabled = true;
        try {
          await bootApp();
        } finally {
          recheckBtn.disabled = false;
        }
      });
    }

    $$('[data-close-modal]').forEach((el) => {
      el.addEventListener('click', () => closeModal(el));
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        $$('.modal:not(.hidden)').forEach((m) => closeModal(m));
      }
    });
  }

  async function startAfterDbReady() {
    await loadSettings();
    await loadProjects();
    applyThisWeek('enter');
    applyThisWeek('history');
    const active = state.projects.filter((p) => p.is_active);
    const enterSelect = $('#enter-projects');
    $$('option', enterSelect).forEach((opt, i) => {
      opt.selected = i < Math.min(3, active.length);
    });
    if (active.length) {
      await loadEnterGrid(false);
    }
    await refreshHistory();
  }

  async function bootApp() {
    const php = await checkPhpHealth();
    if (!php.ok) {
      showPhpSetupOverlay(php);
      toast(PHP_NOT_RUNNING_MSG, 'error');
      return false;
    }
    hidePhpSetupOverlay();
    if (php.mysqli === false) {
      toast('PHP is running but mysqli is missing — enable php-mysqli on the VPS', 'error');
    }

    try {
      const dbInfo = await fetchDbConfig();
      if (!dbInfo.connected || !dbInfo.tables_ready) {
        showDbSetupOverlay(dbInfo);
        return false;
      }
      hideDbSetupOverlay();
      await startAfterDbReady();
      return true;
    } catch (err) {
      if (err.code === 'PHP_NOT_RUNNING') {
        showPhpSetupOverlay({ raw: err.message });
      } else {
        try {
          const dbInfo = await fetchDbConfig();
          showDbSetupOverlay(dbInfo);
        } catch (_) {
          showDbSetupOverlay(null);
        }
      }
      toast(err.message, 'error');
      return false;
    }
  }

  async function init() {
    bindEvents();
    await bootApp();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
