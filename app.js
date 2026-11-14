'use strict';
const $ = id => document.getElementById(id);
let pack, urls = {}, answers = {}, phaseIndex = 0, position = 0, drawing = null, zoom = 1, timing = null;
const el = (tag, text, className) => { const x = document.createElement(tag); if (text !== undefined) x.textContent = text; if (className) x.className = className; return x; };
const storageKey = () => `pathology-review:${pack.package_id}:${pack.reviewer_id}`;
const completionKey = id => `pathology-review-completed:${id}:${pack.reviewer_id}`;
const phases = () => [...new Set(pack.tasks.map(t => t.phase))];
const phaseTasks = () => pack.tasks.filter(t => t.phase === phases()[phaseIndex]);
const current = () => phaseTasks()[position];
const taskAnswers = t => answers[t.id] || { answer: {}, regions: [] };
function stopTiming() {
  if (!timing) return;
  const row = taskAnswers(timing.task);
  row.elapsed_ms = (row.elapsed_ms || 0) + Math.max(0, Math.round(performance.now() - timing.started));
  answers[timing.task.id] = row; timing = null;
}
function startTiming(t) { if (t.record_time && !document.hidden) timing = { task: t, started: performance.now() }; }
function validate(t, row) {
  const a = row.answer || {};
  if (typeof a.notes !== 'undefined' && (typeof a.notes !== 'string' || a.notes.length > 2000)) return '备注过长';
  for (const q of t.questions) {
    const value = a[q.key];
    if (q.type === 'multi' && (!Array.isArray(value) || (q.required && !value.length) || value.some(v => !Object.hasOwn(q.options, v)) || new Set(value).size !== value.length)) return `请填写：${q.label}`;
    if (q.type === 'multi' && value.length > 1 && value.some(v => ['none', 'uncertain', 'na'].includes(v))) return `“无明显”或“不确定”须单独选择：${q.label}`;
    if (q.type === 'number' && value !== 'na' && (q.required || (value !== '' && value != null)) && (value === '' || value == null || !Number.isFinite(Number(value)) || Number(value) < q.min || Number(value) > q.max)) return `请填写：${q.label}`;
    if (q.type === 'choice' && (q.required || value) && !Object.hasOwn(q.options, value)) return `请填写：${q.label}`;
  }
  if (a.evaluable === 'no' && ['atypia', 'maturation', 'inflammation', 'architecture', 'severity'].some(k => a[k] && a[k] !== 'na')) return '图像不能评价时，各形态项请选择“无法评价”';
  if (a.comparable === 'no' && a.similarity && a.similarity !== 'na') return '无法比较时，相似程度请选择“无法判断”';
  if (!Array.isArray(row.regions) || row.regions.some(r => !t.allow_regions || r.image !== t.panels[0].images[0] || !['certain', 'uncertain'].includes(r.certainty) || !['lesion', 'normal_mature_epithelium', 'atypia', 'maturation', 'inflammation', 'architecture', 'other', 'uncertain'].includes(r.label) || !Array.isArray(r.points) || r.points.length < 3 || r.points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v) || v < 0 || v > 1)))) return '局部标记无效，请重新标记';
  return '';
}
const complete = t => !validate(t, taskAnswers(t));
function persist() {
  try { localStorage.setItem(storageKey(), JSON.stringify(answers)); if (pack.tasks.every(complete)) localStorage.setItem(completionKey(pack.package_id), 'yes'); else localStorage.removeItem(completionKey(pack.package_id)); $('saveStatus').textContent = '已保存在当前浏览器'; }
  catch { $('saveStatus').textContent = '无法自动保存，请及时导出结果'; }
  updateProgress();
}
function updateProgress() {
  const n = pack.tasks.filter(complete).length;
  $('progress').textContent = `已完成 ${n} / ${pack.tasks.length}`;
  $('counter').textContent = `${position + 1} / ${phaseTasks().length}`;
  const allowed = phases().map((_, i) => phases().slice(0, i).every(p => pack.tasks.filter(t => t.phase === p).every(complete)));
  [...$('phase').options].forEach((o, i) => { o.disabled = !allowed[i]; });
}
function capture() {
  if (!pack || !current()) return;
  stopTiming(); startTiming(current());
  const t = current(), row = taskAnswers(t), form = new FormData($('form'));
  for (const q of t.questions) {
    if (q.type === 'multi') row.answer[q.key] = form.getAll(q.key);
    else if (q.type === 'number') row.answer[q.key] = form.get(`${q.key}_na`) ? 'na' : (form.get(q.key) || '');
    else row.answer[q.key] = form.get(q.key) || '';
  }
  row.answer.notes = $('notes').value;
  row.updated_at = new Date().toISOString();
  answers[t.id] = row;
  persist();
}
function drawOverlay(svg) {
  svg.replaceChildren(); svg.classList.toggle('active', drawing !== null);
  for (const region of taskAnswers(current()).regions || []) {
    const polygon = document.createElementNS(svg.namespaceURI, 'polygon');
    polygon.setAttribute('points', region.points.map(p => `${p[0] * 1000},${p[1] * 1000}`).join(' ')); svg.append(polygon);
  }
  if (drawing) {
    const line = document.createElementNS(svg.namespaceURI, 'polyline');
    line.setAttribute('points', drawing.map(p => `${p[0] * 1000},${p[1] * 1000}`).join(' ')); svg.append(line);
  }
  svg.onclick = e => {
    if (!drawing) return;
    const rect = svg.getBoundingClientRect();
    drawing.push([Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))]);
    renderImages(); renderZoomOverlay();
  };
}
function renderZoomOverlay() {
  if (!$('zoomDraw').hidden) drawOverlay($('zoomOverlay'));
  $('zoomOverlay').hidden = $('zoomDraw').hidden;
  $('zoomStartPolygon').disabled = drawing !== null;
  $('zoomFinishPolygon').disabled = !drawing || drawing.length < 3;
  $('zoomUndoPoint').disabled = !drawing || !drawing.length;
}
function imagePanel(id, title, allowDrawing) {
  const outer = el('div', undefined, 'panel');
  if (title) outer.append(el('div', title, 'panel-title'));
  const wrap = el('div', undefined, 'image-wrap'), image = el('img');
  image.src = urls[id]; image.alt = '评阅图像'; wrap.append(image);
  if (allowDrawing) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 1000 1000'); svg.setAttribute('preserveAspectRatio', 'none');
    drawOverlay(svg);
    wrap.append(svg);
  }
  const button = el('button', '放大'); button.type = 'button';
  button.onclick = () => { zoom = 1; $('zoomImage').src = urls[id]; $('zoomWrap').style.width = '100%'; $('zoomDraw').hidden = !allowDrawing; $('zoomRegionLabel').replaceChildren(...[...$('regionLabel').options].map(o => o.cloneNode(true))); $('zoomRegionLabel').value = $('regionLabel').value; $('zoomRegionCertainty').value = $('regionCertainty').value; $('viewer').showModal(); renderZoomOverlay(); };
  wrap.append(button); outer.append(wrap); return outer;
}
function renderImages() {
  const t = current(); $('panels').replaceChildren();
  const panels = el('div', undefined, `panel-grid${t.panels.length === 1 ? ' single' : ''}`);
  t.panels.forEach((panel, i) => {
    if (panel.images.length === 1) panels.append(imagePanel(panel.images[0], panel.label, t.allow_regions && i === 0));
    else {
      const group = el('div', undefined, 'panel'); group.append(el('div', panel.label, 'panel-title'));
      const gallery = el('div', undefined, 'gallery'); panel.images.forEach(id => gallery.append(imagePanel(id, '', false))); group.append(gallery); panels.append(group);
    }
  });
  $('panels').append(panels);
  $('drawControls').hidden = !t.allow_regions;
  $('finishPolygon').disabled = !drawing || drawing.length < 3;
  $('undoPoint').disabled = !drawing || !drawing.length;
  $('startPolygon').disabled = drawing !== null;
}
function render() {
  stopTiming();
  const t = current(); if (!t) return;
  drawing = null; $('taskTitle').textContent = t.title; $('taskHelp').textContent = t.help || '';
  $('form').replaceChildren();
  const a = taskAnswers(t).answer;
  for (const q of t.questions) {
    const field = el('fieldset'); field.append(el('legend', q.label));
    if (q.type === 'choice' || q.type === 'multi') {
      const options = el('div', undefined, 'options');
      for (const [value, label] of Object.entries(q.options)) {
        const wrap = el('label', undefined, 'option'), input = el('input'); input.type = q.type === 'multi' ? 'checkbox' : 'radio'; input.name = q.key; input.value = value;
        input.checked = Array.isArray(a[q.key]) ? a[q.key].includes(value) : a[q.key] === value;
        wrap.append(input, el('span', label)); options.append(wrap);
      }
      field.append(options);
    } else if (q.type === 'number') {
      const input = el('input'); input.type = 'number'; input.name = q.key; input.min = q.min; input.max = q.max; input.step = q.step || 1; input.value = a[q.key] === 'na' ? '' : (a[q.key] ?? '');
      const label = el('label'), na = el('input'); na.type = 'checkbox'; na.name = `${q.key}_na`; na.checked = a[q.key] === 'na'; label.append(na, document.createTextNode(' 无法评价')); field.append(input, document.createTextNode(' '), label);
    }
    $('form').append(field);
  }
  $('notes').value = a.notes || ''; $('error').textContent = ''; $('previous').disabled = position === 0;
  $('phase').value = String(phaseIndex); renderImages(); updateProgress(); startTiming(t);
}
function openWorkspace() { $('welcome').hidden = true; $('prerequisite').hidden = true; $('workspace').hidden = false; render(); }
function install(manifest, imageUrls) {
  if (manifest.version !== 'validation-baseline-1' || !manifest.package_id || !manifest.reviewer_id || !Array.isArray(manifest.tasks) || !manifest.tasks.length) throw Error('评阅材料格式不正确');
  if (new Set(manifest.tasks.map(t => t.id)).size !== manifest.tasks.length || manifest.tasks.some(t => !t.id || !t.phase || !Array.isArray(t.panels) || !Array.isArray(t.questions) || t.panels.some(p => p.images.some(i => !imageUrls[i])))) throw Error('评阅材料不完整');
  pack = manifest; urls = imageUrls; phaseIndex = 0; position = 0;
  try { answers = JSON.parse(localStorage.getItem(storageKey()) || '{}'); } catch { answers = {}; }
  $('identity').textContent = `${pack.simulated ? '演示材料' : '独立评阅'} · ${pack.reviewer_id}`;
  $('phase').replaceChildren(); phases().forEach((p, i) => { const o = el('option', p); o.value = String(i); $('phase').append(o); });
  let unlocked = !pack.requires;
  try { unlocked ||= localStorage.getItem(completionKey(pack.requires.package_id)) === 'yes'; } catch { /* Import the previous export instead. */ }
  if (unlocked) openWorkspace(); else { $('welcome').hidden = true; $('workspace').hidden = true; $('prerequisite').hidden = false; }
}
$('previousResult').onchange = async e => { try { const data = JSON.parse(await e.target.files[0].text()), required = pack.requires; const completed = new Set((data.responses || []).map(r => r.task_id)); if (data.version !== pack.version || data.package_id !== required.package_id || data.reviewer_id !== pack.reviewer_id || data.stage !== (required.stage || pack.stage) || !!data.simulated !== !!pack.simulated || !required.task_ids.every(id => completed.has(id))) throw Error('上一组尚未完成或文件不匹配'); try { localStorage.setItem(completionKey(required.package_id), 'yes'); } catch { /* Remains unlocked for this session. */ } openWorkspace(); } catch (err) { $('prerequisiteError').textContent = err.message; } e.target.value = ''; };
document.addEventListener('visibilitychange', () => { if (!pack || !current()) return; if (document.hidden) { stopTiming(); persist(); } else startTiming(current()); });
async function loadFolder(files) {
  const manifests = files.filter(f => f.name === 'manifest.json');
  if (manifests.length !== 1) throw Error('请选择包含一个 manifest.json 的完整评阅文件夹');
  const manifest = JSON.parse(await manifests[0].text()), images = {};
  for (const [id, path] of Object.entries(manifest.images || {})) {
    const matches = files.filter(f => (f.webkitRelativePath || f.name).endsWith(`/${path}`) || f.name === path.split('/').pop());
    if (matches.length !== 1) throw Error('材料中的图像缺失或重名，请重新选择完整文件夹');
    images[id] = URL.createObjectURL(matches[0]);
  }
  install(manifest, images);
}
$('folder').onchange = async e => { try { await loadFolder([...e.target.files]); } catch (err) { alert(`无法打开：${err.message}`); } e.target.value = ''; };
$('demo').onclick = async () => { try { const m = await (await fetch('demo/manifest.json')).json(), images = {}; for (const [id, path] of Object.entries(m.images)) images[id] = `demo/${path}`; install(m, images); } catch { alert('演示材料暂不可用'); } };
$('form').addEventListener('input', capture); $('form').addEventListener('submit', e => e.preventDefault()); $('notes').addEventListener('input', capture);
$('previous').onclick = () => { capture(); position = Math.max(0, position - 1); render(); };
$('skip').onclick = () => { capture(); position = Math.min(position + 1, phaseTasks().length - 1); render(); };
$('next').onclick = () => { capture(); const error = validate(current(), taskAnswers(current())); if (error) { $('error').textContent = error; return; } if (position + 1 < phaseTasks().length) position++; else if (phaseTasks().every(complete) && phaseIndex + 1 < phases().length) { phaseIndex++; position = 0; } else { $('saveStatus').textContent = '本组已完成，请导出结果'; } render(); };
$('phase').onchange = e => { capture(); phaseIndex = Number(e.target.value); position = 0; render(); };
$('startPolygon').onclick = $('zoomStartPolygon').onclick = () => { drawing = []; renderImages(); renderZoomOverlay(); };
$('undoPoint').onclick = $('zoomUndoPoint').onclick = () => { if (drawing) drawing.pop(); renderImages(); renderZoomOverlay(); };
function finishPolygon() { if (!drawing || drawing.length < 3) return; const row = taskAnswers(current()); row.regions = row.regions || []; row.regions.push({ image: current().panels[0].images[0], label: $('regionLabel').value, certainty: $('regionCertainty').value, points: drawing }); answers[current().id] = row; drawing = null; persist(); renderImages(); renderZoomOverlay(); }
$('finishPolygon').onclick = $('zoomFinishPolygon').onclick = finishPolygon;
$('zoomRegionLabel').onchange = e => { $('regionLabel').value = e.target.value; };
$('zoomRegionCertainty').onchange = e => { $('regionCertainty').value = e.target.value; };
$('clearPolygon').onclick = () => { const row = taskAnswers(current()); row.regions = []; answers[current().id] = row; drawing = null; persist(); renderImages(); };
$('export').onclick = () => { capture(); const payload = { version: pack.version, package_id: pack.package_id, reviewer_id: pack.reviewer_id, stage: pack.stage, simulated: !!pack.simulated, exported_at: new Date().toISOString(), responses: pack.tasks.filter(complete).map(t => ({ task_id: t.id, ...taskAnswers(t) })), drafts: answers }; const u = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })); const a = el('a'); a.href = u; a.download = `评阅结果_${pack.reviewer_id}_${pack.stage}_${pack.package_id.slice(0, 8)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); };
$('restore').onclick = () => $('restoreFile').click();
$('restoreFile').onchange = async e => { try { const data = JSON.parse(await e.target.files[0].text()); if (data.version !== pack.version || data.package_id !== pack.package_id || data.reviewer_id !== pack.reviewer_id || data.stage !== pack.stage || !!data.simulated !== !!pack.simulated) throw Error('文件不属于当前评阅材料'); const known = new Set(pack.tasks.map(t => t.id)); if (!data.drafts || Object.keys(data.drafts).some(k => !known.has(k))) throw Error('文件包含未知题目'); answers = { ...answers, ...data.drafts }; persist(); render(); $('saveStatus').textContent = '已导入进度'; } catch (err) { $('error').textContent = `导入失败：${err.message}`; } e.target.value = ''; };
function setZoom(value) { zoom = Math.max(.5, Math.min(5, value)); $('zoomWrap').style.width = `${zoom * 100}%`; }
$('zoomIn').onclick = () => setZoom(zoom * 1.35); $('zoomOut').onclick = () => setZoom(zoom / 1.35); $('closeViewer').onclick = () => $('viewer').close();
