import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

/* 家具定義（増やす場合はここに追記） */
const furnitures = [
  { id: 'desk', label: '机', file: '机.glb' },
  { id: 'sofa', label: 'ソファ', file: 'ソファ.glb' },
];

let currentFurniture = null; // ★ 今どの家具（机/ソファ）を編集しているか


// 家具プリセット保存用キー（間取り図側と共有）
const STORAGE_KEY = 'madomake_furniturePresets';

/* DOM */
const canvas = document.getElementById('canvas');
const furnList = document.getElementById('furnList');
const partsList = document.getElementById('parts');
const current = document.getElementById('current');
const btnReset = document.getElementById('btnReset');
const btnExport = document.getElementById('btnExport');
const importJson = document.getElementById('importJson');
const uiColor = document.getElementById('uiColor');
const btnApplyColor = document.getElementById('btnApplyColor');
const btnIsolate = document.getElementById('btnIsolate');
const btnShowAll = document.getElementById('btnShowAll');
const sizeX = document.getElementById('sizeX');
const sizeY = document.getElementById('sizeY');
const sizeZ = document.getElementById('sizeZ');
const btnApplySize = document.getElementById('btnApplySize');
const sizeInputs = document.querySelectorAll('.sizeInput');
const presetName = document.getElementById('presetName');
const btnSavePreset = document.getElementById('btnSavePreset');
const presetList = document.getElementById('presetList');

/* Three.js 基本 */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(100, 100);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
camera.position.set(2.5, 1.6, 3.2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.75, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8bbbd9, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(5, 8, 4);
scene.add(dir);

// グリッド
const grid = new THREE.GridHelper(10, 20, 0xdddddd, 0xeeeeee);
scene.add(grid);

/* === 視認性UP: 中心の床線（X=赤、Z=青） === */
const AXIS_SIZE = 10;
const AXIS_THICK = 0.025;
const axisGroup = new THREE.Group();
// X軸（横）
const xLine = new THREE.Mesh(
  new THREE.BoxGeometry(AXIS_SIZE, 0.002, AXIS_THICK),
  new THREE.MeshBasicMaterial({ color: '#e74a3b' })
);
xLine.position.set(0, 0.001, 0);
axisGroup.add(xLine);
// Z軸（奥行）
const zLine = new THREE.Mesh(
  new THREE.BoxGeometry(AXIS_THICK, 0.002, AXIS_SIZE),
  new THREE.MeshBasicMaterial({ color: '#3498db' })
);
zLine.position.set(0, 0.001, 0);
axisGroup.add(zLine);
scene.add(axisGroup);

/* 環境マップ（見た目向上） */
const pmrem = new THREE.PMREMGenerator(renderer);
new RGBELoader()
  .setDataType(THREE.HalfFloatType)
  .load(
    'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/venice_sunset_1k.hdr',
    (tex) => {
      scene.environment = pmrem.fromEquirectangular(tex).texture;
      tex.dispose();
    }
  );

/* ローダー */
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(
  new DRACOLoader().setDecoderPath(
    'https://cdn.jsdelivr.net/npm/three@0.159/examples/jsm/libs/draco/'
  )
);
gltfLoader.setKTX2Loader(
  new KTX2Loader()
    .setTranscoderPath(
      'https://cdn.jsdelivr.net/npm/three@0.159/examples/jsm/libs/basis/'
    )
    .detectSupport(renderer)
);

/* CSS2D 寸法ラベル（□m） */
const viewport = document.getElementById('viewport');
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'label-layer';
viewport.appendChild(labelRenderer.domElement);

function makeLabel(axis) {
  const el = document.createElement('div');
  el.className = `dimLabel dim-${axis}`;
  el.innerHTML = `<span class="value">—</span><span class="unit">m</span>`;
  const wrap = document.createElement('div');
  wrap.style.position = 'absolute';
  wrap.appendChild(el);
  labelRenderer.domElement.appendChild(wrap);
  return { el, wrap, obj: new THREE.Object3D() };
}

const labelX = makeLabel('x');
const labelY = makeLabel('y');
const labelZ = makeLabel('z');
scene.add(labelX.obj, labelY.obj, labelZ.obj);

/* 外寸ガイド（矢印線） */
const GUIDE_THICK = 0.010;
const GUIDE_OFFSET = 0.05;
const HEAD_BASE_H = 1;
const HEAD_BASE_R = 0.10;

function makeDimGuide(color, axis) {
  const g = new THREE.Group();

  let shaftGeom;
  if (axis === 'x') shaftGeom = new THREE.BoxGeometry(1, GUIDE_THICK, GUIDE_THICK);
  else if (axis === 'y') shaftGeom = new THREE.BoxGeometry(GUIDE_THICK, 1, GUIDE_THICK);
  else shaftGeom = new THREE.BoxGeometry(GUIDE_THICK, GUIDE_THICK, 1);

  const mat = new THREE.MeshBasicMaterial({ color, depthTest: true });
  const shaft = new THREE.Mesh(shaftGeom, mat);
  g.add(shaft);

  const headGeom = new THREE.ConeGeometry(HEAD_BASE_R, HEAD_BASE_H, 16);
  const head1 = new THREE.Mesh(headGeom, mat.clone());
  const head2 = new THREE.Mesh(headGeom, mat.clone());
  g.add(head1, head2);

  g.userData = { axis, shaft, head1, head2, color };
  return g;
}

const guideX = makeDimGuide('#e74a3b', 'x');
const guideY = makeDimGuide('#2ECC71', 'y');
const guideZ = makeDimGuide('#3498db', 'z');
scene.add(guideX, guideY, guideZ);

function updateGuide(guide, start, end) {
  const { axis, shaft, head1, head2 } = guide.userData;
  const dir = new THREE.Vector3().subVectors(end, start);
  const len = dir.length();
  if (len < 1e-6) { guide.visible = false; return; }
  guide.visible = true;

  const center = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
  guide.position.copy(center);

  const headLen = Math.min(0.25, Math.max(0.06, len * 0.10));
  const shaftLen = Math.max(0.001, len - headLen * 2);

  if (axis === 'x') shaft.scale.set(shaftLen, 1, 1);
  else if (axis === 'y') shaft.scale.set(1, shaftLen, 1);
  else shaft.scale.set(1, 1, shaftLen);

  const headRadius = GUIDE_THICK * 1.8;
  const scaleR = headRadius / HEAD_BASE_R;
  const scaleH = headLen / HEAD_BASE_H;
  if (axis === 'x') {
    head1.scale.set(scaleH, scaleR, scaleR);
    head2.scale.set(scaleH, scaleR, scaleR);
  } else if (axis === 'y') {
    head1.scale.set(scaleR, scaleH, scaleR);
    head2.scale.set(scaleR, scaleH, scaleR);
  } else {
    head1.scale.set(scaleR, scaleR, scaleH);
    head2.scale.set(scaleR, scaleR, scaleH);
  }

  const offStart = new THREE.Vector3().subVectors(start, center);
  const offEnd = new THREE.Vector3().subVectors(end, center);
  head1.position.copy(offEnd);
  head2.position.copy(offStart);
}

/* 状態 */
let root = null, nodes = [], selected = null;
let initialState = {};
const bbox = new THREE.Box3(), sizeV = new THREE.Vector3(), centerV = new THREE.Vector3();
let isEditingSize = false;

/* ユーティリティ */
const h = (t, p = {}, ...c) => {
  const e = document.createElement(t);
  Object.entries(p).forEach(([k, v]) => {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) e.setAttribute(k, v);
  });
  c.forEach((x) => e.appendChild(typeof x === 'string'
    ? document.createTextNode(x)
    : x
  ));
  return e;
};

const stdMat = (n) =>
  (n?.isMesh ? (Array.isArray(n.material) ? n.material[0] : n.material) : null);

function worldToScreen(obj) {
  const v = obj.getWorldPosition(new THREE.Vector3()).clone().project(camera);
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  return {
    x: (v.x * 0.5 + 0.5) * w,
    y: (-v.y * 0.5 + 0.5) * h
  };
}

/* ========== ライブラリ保存／呼び出し (localStorage) ========== */

function loadPresets() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return data && Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

function savePresets(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, items: list }));
}

function renderPresetList() {
  if (!presetList) return;

  const list = loadPresets();
  presetList.innerHTML = '';

  if (!list.length) {
    const p = document.createElement('p');
    p.textContent = '保存された家具はありません。';
    p.className = 'hint';
    presetList.appendChild(p);
    return;
  }

  list.forEach((preset) => {
    const row = h('div', { class: 'item' },
      h('span', { class: 'name' }, preset.name || '(名称未設定)'),
      h('button', {
        onclick: async () => {
          await applyPresetToEditor(preset);
        }
      }, '呼び出し'),
      h('button', {
        onclick: () => {
          const arr = loadPresets().filter(p => p.id !== preset.id);
          savePresets(arr);
          renderPresetList();
        }
      }, '削除')
    );
    presetList.appendChild(row);
  });
}

async function applyPresetToEditor(preset) {
  const base = furnitures.find(f => f.id === preset.baseId) || furnitures[0];
  const idx = furnitures.indexOf(base);
  const btnEl = furnList.children[idx];

  await selectFurniture(base, btnEl);

  if (sizeX && sizeY && sizeZ) {
    sizeX.value = (preset.size?.x ?? 1).toFixed(2);
    sizeY.value = (preset.size?.y ?? 1).toFixed(2);
    sizeZ.value = (preset.size?.z ?? 1).toFixed(2);
    applySize();
  }

  if (preset.color && uiColor && btnApplyColor) {
    uiColor.value = preset.color;
    btnApplyColor.click();
  }
}

/* 家具UI生成 */
function buildFurnitureUI() {
  furnList.innerHTML = '';
  furnitures.forEach((f, i) => {
    const btn = h('button', { class: 'furn-btn', onclick: () => selectFurniture(f, btn) }, f.label);
    if (i === 0) btn.classList.add('active');
    furnList.appendChild(btn);
  });
}

async function selectFurniture(f, btnEl) {
  currentFurniture = f;
  [...furnList.children].forEach((b) => b.classList.remove('active'));
  btnEl?.classList.add('active');
  currentFurniture = f;
  await loadModel(f.file);
}


/* パーツ一覧 */
function refreshPartsList() {
  partsList.innerHTML = '';
  nodes.forEach((n) => {
    const item = h('div', { class: 'item' },
      h('input', {
        type: 'checkbox', ...(n.visible ? { checked: '' } : {}),
        oninput: (e) => { n.visible = e.target.checked; updateBBoxAndLabels(true); }
      }),
      h('span', { class: 'name' }, n.name || '(no-name)'),
      h('button', { onclick: () => selectNode(n) }, '選択')
    );
    partsList.appendChild(item);
  });
}

function selectNode(n) {
  selected = n;
  current.textContent = n ? (n.name || '(no-name)') : '—';
}

/* 外寸＆ガイド更新（家具の“外側”に矢印を回す版） */
function updateBBoxAndLabels(skipInputSync = false) {
  if (!root) {
    labelX.wrap.style.display = 'none';
    labelY.wrap.style.display = 'none';
    labelZ.wrap.style.display = 'none';
    guideX.visible = guideY.visible = guideZ.visible = false;
    return;
  }

  // バウンディングボックス取得
  bbox.setFromObject(root);
  if (!bbox.isEmpty()) {
    bbox.getSize(sizeV);
    bbox.getCenter(centerV);
  } else {
    sizeV.set(0, 0, 0);
    centerV.set(0, 0, 0);
  }

  // 寸法（数値と入力欄）
  const sx = sizeV.x.toFixed(2);
  const sy = sizeV.y.toFixed(2);
  const sz = sizeV.z.toFixed(2);

  labelX.el.querySelector('.value').textContent = sx;
  labelY.el.querySelector('.value').textContent = sy;
  labelZ.el.querySelector('.value').textContent = sz;

  if (!skipInputSync) {
    sizeX.value = sx;
    sizeY.value = sy;
    sizeZ.value = sz;
  }

  const off = GUIDE_OFFSET;
  const outer = off * 2; // 家具の外側に少し余裕を持たせるオフセット

  // ===== X方向（横幅）：家具の「手前側」（+Z 側）に矢印 =====
  const xY = bbox.min.y - off;            // 床から少し下げる
  const xZ = bbox.max.z + outer;          // 家具の手前（+Z 側）にオフセット
  const xStart = new THREE.Vector3(bbox.min.x - off, xY, xZ);
  const xEnd = new THREE.Vector3(bbox.max.x + off, xY, xZ);
  updateGuide(guideX, xStart, xEnd);

  const xMid = new THREE.Vector3().addVectors(xStart, xEnd).multiplyScalar(0.5);
  labelX.obj.position.copy(xMid.clone().add(new THREE.Vector3(0, off, 0))); // 矢印の少し上にラベル

  // ===== Z方向（奥行）：家具の「右側」（+X 側）に矢印 =====
  const zY = bbox.min.y - off;
  const zX = bbox.max.x + outer;          // 家具の右側（+X 側）
  const zStart = new THREE.Vector3(zX, zY, bbox.min.z - off);
  const zEnd = new THREE.Vector3(zX, zY, bbox.max.z + off);
  updateGuide(guideZ, zStart, zEnd);

  const zMid = new THREE.Vector3().addVectors(zStart, zEnd).multiplyScalar(0.5);
  labelZ.obj.position.copy(zMid.clone().add(new THREE.Vector3(0, off, 0)));

  // ===== Y方向（高さ）：家具の右前の角の「外側」に縦の矢印 =====
  const yX = bbox.max.x + outer;
  const yZ = bbox.max.z + outer;
  const yStart = new THREE.Vector3(yX, bbox.min.y - off, yZ);
  const yEnd = new THREE.Vector3(yX, bbox.max.y + off, yZ);
  updateGuide(guideY, yStart, yEnd);

  const yMid = new THREE.Vector3().addVectors(yStart, yEnd).multiplyScalar(0.5);
  labelY.obj.position.copy(yMid.clone().add(new THREE.Vector3(0, off, 0)));

  // ===== ラベルのスクリーン座標計算 =====
  [labelX, labelY, labelZ].forEach((lab) => {
    const { x, y } = worldToScreen(lab.obj);
    lab.wrap.style.left = `${x}px`;
    lab.wrap.style.top = `${y}px`;
    lab.wrap.style.display = 'block';
  });
}


/* 寸法変更適用 */
function applySize() {
  if (!root) return;

  const targetX = parseFloat(sizeX.value) || 0;
  const targetY = parseFloat(sizeY.value) || 0;
  const targetZ = parseFloat(sizeZ.value) || 0;

  bbox.setFromObject(root);
  bbox.getSize(sizeV);

  const sx = sizeV.x || 1;
  const sy = sizeV.y || 1;
  const sz = sizeV.z || 1;

  const scale = new THREE.Vector3(
    targetX / sx,
    targetY / sy,
    targetZ / sz
  );

  isEditingSize = true;
  root.scale.set(scale.x, scale.y, scale.z);
  updateBBoxAndLabels(true);
  isEditingSize = false;
}

/* 色適用（選択なし→全体） */
btnApplyColor.addEventListener('click', () => {
  const targets = selected ? [selected] : nodes;
  targets.forEach((n) => {
    const m = stdMat(n); if (!m) return;
    (m.color ||= new THREE.Color()).set(uiColor.value);
    m.needsUpdate = true;
  });
});

/* モデル読込（日本語ファイル名OK） */
async function loadModel(urlRaw) {
  try {
    const base = new URL('.', window.location.href);
    const abs = new URL(urlRaw.trim(), base).href;

    if (root) {
      scene.remove(root);
      root.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material?.dispose) o.material.dispose();
      });
    }
    nodes = [];
    selected = null;
    initialState = {};
    current.textContent = '—';

    const gltf = await new Promise((res, rej) => gltfLoader.load(abs, res, undefined, rej));
    root = gltf.scene;
    scene.add(root);

    root.traverse((o) => {
      if (o.isMesh) {
        nodes.push(o);
        const m = stdMat(o);
        initialState[o.uuid] = {
          visible: o.visible,
          color: m?.color?.getHex?.() ?? null,
          name: o.name || ''
        };
      }
    });

    // カメラ合わせ
    const b = new THREE.Box3().setFromObject(root);
    const s = new THREE.Vector3();
    const c = new THREE.Vector3();
    b.getSize(s);
    b.getCenter(c);
    controls.target.copy(c);
    const maxDim = Math.max(s.x, s.y, s.z);
    const camZ = (maxDim * 1.7) / Math.tan((camera.fov * Math.PI) / 360);
    camera.position.set(c.x + camZ * 0.25, c.y + maxDim * 0.8, c.z + camZ);
    camera.lookAt(c);
    controls.update();

    refreshPartsList();
    updateBBoxAndLabels();
  } catch (err) {
    console.error('[GLB load failed]', err);
    alert('モデルの読み込みに失敗しました。GLBの配置とファイル名を確認してください。');
  }
}

/* 上部ボタン */
btnReset.addEventListener('click', () => {
  nodes.forEach((n) => {
    const st = initialState[n.uuid]; if (!st) return;
    n.visible = st.visible;
    const m = stdMat(n);
    if (m && st.color != null) { m.color.setHex(st.color); m.needsUpdate = true; }
  });
  if (root) root.scale.set(1, 1, 1);
  refreshPartsList();
  updateBBoxAndLabels();
});

btnExport.addEventListener('click', () => {
  const data = nodes.map((n) => {
    const m = stdMat(n);
    return {
      uuid: n.uuid,
      name: n.name || '',
      visible: n.visible,
      material: m ? { color: m.color?.getHex?.() ?? null } : null
    };
  });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'furniture-config.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

importJson.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const text = await f.text();
  let data = [];
  try { data = JSON.parse(text); } catch { alert('JSONの読み込みに失敗しました'); return; }
  const map = new Map(data.map((d) => [d.uuid, d]));
  nodes.forEach((n) => {
    const d = map.get(n.uuid); if (!d) return;
    n.visible = !!d.visible;
    const m = stdMat(n);
    if (m && d.material && d.material.color != null) {
      m.color.setHex(d.material.color);
      m.needsUpdate = true;
    }
  });
  refreshPartsList();
  updateBBoxAndLabels(true);
});

btnIsolate.addEventListener('click', () => {
  if (!selected) return;
  nodes.forEach((n) => (n.visible = n === selected));
  refreshPartsList();
  updateBBoxAndLabels(true);
});

btnShowAll.addEventListener('click', () => {
  nodes.forEach((n) => (n.visible = true));
  refreshPartsList();
  updateBBoxAndLabels(true);
});

btnApplySize.addEventListener('click', () => {
  applySize();
});

renderPresetList();
if (presetName) presetName.value = '';


/* レイアウト＆ループ */
function resize() {
  const rect = viewport.getBoundingClientRect();
  const w = Math.max(360, rect.width);
  const h = Math.max(320, rect.height);
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

renderer.setAnimationLoop(() => {
  controls.update();
  updateBBoxAndLabels(true);
  labelRenderer.render(scene, camera);
  renderer.render(scene, camera);
});

/* 起動：UI生成→最初の家具を自動表示 */
resize();
buildFurnitureUI();
renderPresetList();
selectFurniture(furnitures[0], furnList.firstElementChild).catch((err) => {
  console.error(err);
  alert('モデルの読み込みに失敗しました。GLBの配置とファイル名を確認してください。');
});

/* ライブラリ保存ボタン */
if (btnSavePreset) {
  btnSavePreset.addEventListener('click', () => {
    if (!currentFurniture) {
      alert('まず左のリストから机かソファを選択してください。');
      return;
    }
    if (!root) {
      alert('モデルがまだ読み込まれていません。');
      return;
    }

    const name = (presetName.value || currentFurniture.label || currentFurniture.id).trim();
    if (!name) {
      alert('名前を入力してください');
      return;
    }

    const size = {
      x: parseFloat(sizeX.value) || 1,
      y: parseFloat(sizeY.value) || 1,
      z: parseFloat(sizeZ.value) || 1
    };

    const color = uiColor.value || '#8a5a2b';

    let items = loadPresets();
    // 同じ baseId + name があれば上書き
    items = items.filter(p => !(p.baseId === currentFurniture.id && p.name === name));
    items.push({
      id: Date.now(),
      name,
      baseId: currentFurniture.id,  // 'desk' / 'sofa'
      size,
      color,
      createdAt: new Date().toISOString()
    });

    savePresets(items);
    renderPresetList();
    if (presetName) presetName.value = '';
    alert('家具ライブラリに保存しました。\n間取り図生成タブを開くと反映されます。');
  });
}
