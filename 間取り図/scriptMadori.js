import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let accessToken = null;
let latestJson = null;

/* =========================
   Roboflow settings（更新版）
   ========================= */
// 3モデル（newscript.js の構成を移植）
const ROBOFLOW_API = {
  outer: "https://detect.roboflow.com/floor-plan-japan-base-6xuaz/2?api_key=E0aoexJvBDgvE3nb1jkc",
  inner: "https://detect.roboflow.com/floor-plan-japan/7?api_key=E0aoexJvBDgvE3nb1jkc",
  extra: "https://detect.roboflow.com/floor-plan-japan-2-menv0/1?api_key=E0aoexJvBDgvE3nb1jkc&confidence=0.25"
};

// UIは変えないので、常に 3モデル合成を使う
const ROBOFLOW_MODE = "all";

/* ========== Furniture presets (shared with 家具生成タブ) ========== */
const FURN_STORAGE_KEY = 'madomake_furniturePresets';

/* ========== GLB model paths (relative to 間取り図/indexMadori.html) ========== */
const GLB_PATHS = {
  desk: '../家具生成/机.glb',
  sofa: '../家具生成/ソファ.glb'
};

const gltfLoader = new GLTFLoader();

/* ========== Three.js globals ========== */
let scene = null;
let camera = null;
let renderer = null;
let controls = null;

/* ========== Drag / select globals ========== */
let raycaster = null;
let pointer = null;
let dragPlane = null;
let dragOffset = null;
let dragIntersectPoint = null;
let draggableObjects = [];
let selectedObject = null;
let isDragging = false;
let threeContainerRect = null;

/* ========== UI refs ========== */
let placeStatusEl = null;
let moveDoneBtn = null;
let moveDeleteBtn = null;
let boxWEl = null;
let boxHEl = null;
let boxDEl = null;
let fileSelectEl = null;
let libraryListEl = null;

/* Unit scale for boxes (1 = 1m 相当) */
const UNIT_SCALE = 1.0;

/* =========================
   Google Drive 認証
   ========================= */
function handleCredentialResponse(_) {
  console.log('Googleログイン成功');
  requestAccessToken();
}
window.handleCredentialResponse = handleCredentialResponse;

function requestAccessToken() {
  google.accounts.oauth2
    .initTokenClient({
      client_id: '479474446026-kej6f40kvfm6dsuvfeo5d4fm87c6god4.apps.googleusercontent.com',
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (tokenResponse) => {
        accessToken = tokenResponse.access_token;
        console.log('アクセストークン取得済');
        updateFileSelect();
      }
    })
    .requestAccessToken();
}

/* =========================
   localStorage: 家具プリセット取得
   ========================= */
function getFurniturePresets() {
  const raw = localStorage.getItem(FURN_STORAGE_KEY);
  console.log('[MADORI] localStorage key =', FURN_STORAGE_KEY, 'raw =', raw);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.items)) return data.items; // {version, items:[...]}
    if (Array.isArray(data)) return data;                     // 旧形式 [...]
    return [];
  } catch (e) {
    console.error('[MADORI] 家具プリセットのJSONパースに失敗しました', e);
    return [];
  }
}

/* 家具ライブラリの描画 */
function renderFurnitureLibrary() {
  if (!libraryListEl) return;
  const presets = getFurniturePresets();
  libraryListEl.innerHTML = '';
  if (!presets.length) {
    const p = document.createElement('p');
    p.textContent = '家具生成タブで「保存してライブラリへ」を行うとここに表示されます。';
    p.style.fontSize = '12px';
    p.style.color = '#555';
    libraryListEl.appendChild(p);
    return;
  }
  presets.forEach((preset) => {
    const btn = document.createElement('button');
    btn.className = 'libItemBtn';
    btn.textContent = preset.name || '(名称未設定)';
    btn.addEventListener('click', () => {
      spawnFurnitureFromPreset(preset);
    });
    libraryListEl.appendChild(btn);
  });
}

/* プリセットから色を決定（ユーザー指定 > 種類別デフォルト） */
function colorFromPreset(preset) {
  const baseId = preset.baseId || 'generic';
  const DEFAULT_KAGU_COLOR = '#8a5a2b';
  const typeColors = {
    desk: 0x3498db,
    sofa: 0x27ae60
  };

  if (
    typeof preset.color === 'string' &&
    preset.color.startsWith('#') &&
    preset.color.toLowerCase() !== DEFAULT_KAGU_COLOR
  ) {
    const v = parseInt(preset.color.slice(1), 16);
    if (!Number.isNaN(v)) return v;
  }
  return typeColors[baseId] || 0x888888;
}

/* プリセットの外寸を「m」に統一して返す */
function presetSizeToMeters(preset) {
  const size = (preset && preset.size) ? preset.size : {};
  const rx = Number(size.x);
  const ry = Number(size.y);
  const rz = Number(size.z);

  const unitRaw =
    (preset && (preset.sizeUnit || preset.unit || preset.units || preset.lengthUnit)) || '';
  const unit = String(unitRaw).toLowerCase().trim();

  let factor = 1; // 乗算して m にする係数
  if (unit === 'cm') factor = 0.01;
  else if (unit === 'm' || unit === 'meter' || unit === 'meters') factor = 1;
  else {
    // unit が無ければ値から推定（家具寸法で 10m 超は現実的にほぼ無いので cm 扱い）
    const candidates = [rx, ry, rz].filter((v) => Number.isFinite(v));
    const maxv = candidates.length ? Math.max(...candidates) : 1;
    factor = maxv > 10 ? 0.01 : 1;
  }

  const fallbackRaw = (factor === 0.01) ? 100 : 1;
  const xRaw = Number.isFinite(rx) ? rx : fallbackRaw;
  const yRaw = Number.isFinite(ry) ? ry : fallbackRaw;
  const zRaw = Number.isFinite(rz) ? rz : fallbackRaw;

  return {
    x: Math.max(0.1, xRaw * factor),
    y: Math.max(0.1, yRaw * factor),
    z: Math.max(0.1, zRaw * factor)
  };
}

/* プリセットから本物の家具(GLB)を生成 */
async function spawnFurnitureFromPreset(preset) {
  if (!scene) {
    alert('先に「分析（Roboflow）」で3D表示を生成してください。');
    return;
  }

  const target = presetSizeToMeters(preset);

  const baseId = preset.baseId || 'generic';
  const name = preset.name || baseId;
  const modelPath = GLB_PATHS[baseId];
  const colorHex = colorFromPreset(preset);

  if (!modelPath) {
    addBoxAtCenter(target.x, target.y, target.z, colorHex, { baseId, name });
    return;
  }

  try {
    const url = new URL(modelPath, window.location.href).href;
    const gltf = await gltfLoader.loadAsync(url);
    const root = gltf.scene;

    root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });

    const bbox = new THREE.Box3().setFromObject(root);
    const curSize = new THREE.Vector3();
    bbox.getSize(curSize);
    curSize.x = curSize.x || 1;
    curSize.y = curSize.y || 1;
    curSize.z = curSize.z || 1;

    const scaleVec = new THREE.Vector3(
      target.x / curSize.x,
      target.y / curSize.y,
      target.z / curSize.z
    );
    root.scale.copy(scaleVec);

    const bbox2 = new THREE.Box3().setFromObject(root);
    const center2 = new THREE.Vector3();
    bbox2.getCenter(center2);

    root.position.set(-center2.x, -bbox2.min.y, -center2.z);

    root.traverse((o) => {
      if (o.isMesh && o.material && 'color' in o.material) {
        o.material.color.setHex(colorHex);
        o.material.needsUpdate = true;
      }
    });

    root.userData.draggable = true;
    root.userData.baseId = baseId;
    root.userData.label = name;

    scene.add(root);
    draggableObjects.push(root);
    selectObject(root);
  } catch (err) {
    console.error('[MADORI] GLB load failed', err);
    alert('家具モデルの読み込みに失敗しました（' + name + '）。パスやファイル名を確認してください。');
    addBoxAtCenter(target.x, target.y, target.z, colorHex, { baseId, name });
  }
}

/* 手動で出す箱 */
function addBoxAtCenter(w, h, d, color = 0x2194ce, meta = {}) {
  if (!scene) {
    alert('先に「分析（Roboflow）」で3D表示を生成してください。');
    return;
  }
  const geo = new THREE.BoxGeometry(w * UNIT_SCALE, h * UNIT_SCALE, d * UNIT_SCALE);
  const mat = new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);

  mesh.position.set(0, (h * UNIT_SCALE) / 2, 0);

  mesh.userData.draggable = true;
  mesh.userData.baseId = meta.baseId || 'generic';
  mesh.userData.label = meta.name || '箱';

  scene.add(mesh);
  draggableObjects.push(mesh);
  selectObject(mesh);
}

/* 選択状態の更新 */
function selectObject(obj) {
  selectedObject = obj || null;
  if (placeStatusEl) {
    if (!selectedObject) {
      placeStatusEl.textContent = '未選択';
    } else {
      const label = selectedObject.userData?.label || '箱';
      placeStatusEl.textContent = '選択中：' + label;
    }
  }
  if (moveDoneBtn) moveDoneBtn.disabled = !selectedObject;
  if (moveDeleteBtn) moveDeleteBtn.disabled = !selectedObject;
}

/* =========================
   Raycast / Drag
   ========================= */
function updatePointerFromEvent(event) {
  if (!renderer) return;
  if (!threeContainerRect) {
    const container = document.getElementById('three-container');
    threeContainerRect = container.getBoundingClientRect();
  }
  const x = ((event.clientX - threeContainerRect.left) / threeContainerRect.width) * 2 - 1;
  const y = -((event.clientY - threeContainerRect.top) / threeContainerRect.height) * 2 + 1;
  pointer.set(x, y);
}

function pickObject(event) {
  if (!raycaster || !camera || !scene) return null;
  updatePointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);

  const hits = raycaster.intersectObjects(scene.children, true);
  if (!hits.length) return null;

  for (const hit of hits) {
    let obj = hit.object;
    while (obj) {
      if (obj.userData && obj.userData.draggable) {
        return obj;
      }
      obj = obj.parent;
    }
  }
  return null;
}

function onDoubleClick(event) {
  const obj = pickObject(event);
  if (obj) selectObject(obj);
  else selectObject(null);
}

function onPointerDown(event) {
  const obj = pickObject(event);
  if (obj && obj === selectedObject) {
    isDragging = true;
    updatePointerFromEvent(event);
    raycaster.setFromCamera(pointer, camera);

    dragPlane.set(new THREE.Vector3(0, 1, 0), -selectedObject.position.y);
    if (raycaster.ray.intersectPlane(dragPlane, dragIntersectPoint)) {
      dragOffset.subVectors(selectedObject.position, dragIntersectPoint);
    }
    if (controls) controls.enabled = false;
    if (placeStatusEl) placeStatusEl.textContent = 'ドラッグ中…';
  }
}

function onPointerMove(event) {
  if (!isDragging || !selectedObject) return;
  updatePointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);
  if (raycaster.ray.intersectPlane(dragPlane, dragIntersectPoint)) {
    const newPos = new THREE.Vector3().copy(dragIntersectPoint).add(dragOffset);
    selectedObject.position.x = newPos.x;
    selectedObject.position.z = newPos.z;
  }
}

function onPointerUp() {
  if (isDragging) {
    isDragging = false;
    if (controls) controls.enabled = true;
    if (placeStatusEl && selectedObject) {
      const label = selectedObject.userData?.label || '箱';
      placeStatusEl.textContent = '選択中：' + label;
    }
  }
}

/* =========================
   Google Drive ファイル一覧更新
   ========================= */
function updateFileSelect() {
  if (!accessToken || !fileSelectEl) return;
  fetch("https://www.googleapis.com/drive/v3/files?q=mimeType='application/json'", {
    headers: new Headers({ Authorization: 'Bearer ' + accessToken })
  })
    .then((res) => res.json())
    .then((fileList) => {
      fileSelectEl.innerHTML = `<option value="">読み込むファイルを選択</option>`;
      (fileList.files || []).forEach((file) => {
        const option = document.createElement('option');
        option.value = file.id;
        option.textContent = file.name;
        fileSelectEl.appendChild(option);
      });
    })
    .catch((err) => console.error(err));
}

/* =========================
   Roboflow 合成ロジック（newscript.js 移植）
   ========================= */
async function runRoboflow(url, file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(url, { method: 'POST', body: formData });
  return await res.json();
}

function calcIoU(a, b) {
  const ax1 = a.x - a.width / 2;
  const ax2 = a.x + a.width / 2;
  const ay1 = a.y - a.height / 2;
  const ay2 = a.y + a.height / 2;

  const bx1 = b.x - b.width / 2;
  const bx2 = b.x + b.width / 2;
  const by1 = b.y - b.height / 2;
  const by2 = b.y + b.height / 2;

  const interX = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
  const interY = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const intersect = interX * interY;

  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - intersect;

  if (union <= 0) return 0;
  return intersect / union;
}

// Wall ↔ Fusuma の隙間を埋める（Wall↔Wallは無視）
function fillWallGaps(preds, maxDist = 40) {
  const walls = preds.filter(p => p.class === "wall" || p.class === "fusuma");
  const filled = [];

  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const a = walls[i];
      const b = walls[j];

      const isPair =
        (a.class === "wall" && b.class === "fusuma") ||
        (a.class === "fusuma" && b.class === "wall");

      if (!isPair) continue;

      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < maxDist) {
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;

        const newWidth = Math.max(4, Math.abs(a.x - b.x) + 4);
        const newHeight = Math.max(4, Math.abs(a.y - b.y) + 4);

        filled.push({
          class: "wall",
          x: midX,
          y: midY,
          width: newWidth,
          height: newHeight,
          confidence: 0.99
        });
      }
    }
  }
  return filled;
}

// 重なり優先ルール（チラつき防止）
// - Wall vs Closet/Door -> Wall優先（Closet/Doorを落とす）
// - Wall vs Window/Glass door -> Window/Glass door優先（Wallを落とす）
function applyPriority(preds) {
  const result = [];
  const items = preds.slice();

  items.forEach(p => {
    // base/outer は絶対に残す（床生成で使う）
    if (p.class === "base" || p.class === "outer") {
      result.push(p);
      return;
    }

    let skip = false;

    for (let k = 0; k < items.length; k++) {
      const other = items[k];
      if (p === other) continue;

      // base/outer とは比較しない（巨大に重なるので誤除外を防ぐ）
      if (other.class === "base" || other.class === "outer") continue;

      if (calcIoU(p, other) < 0.15) continue;

      if ((p.class === "closet" || p.class === "door") && other.class === "wall") {
        skip = true;
        break;
      }

      if (p.class === "wall" && (other.class === "window" || other.class === "glass door")) {
        skip = true;
        break;
      }

      // 同クラスが高IoUなら confidence 低い方を落とす
      if (p.class === other.class) {
        const iou = calcIoU(p, other);
        if (iou > 0.6) {
          if ((p.confidence || 0) < (other.confidence || 0)) {
            skip = true;
            break;
          }
        }
      }
    }

    if (!skip) result.push(p);
  });

  return result;
}

async function runAllModels(file) {
  const outer = await runRoboflow(ROBOFLOW_API.outer, file);
  const inner = await runRoboflow(ROBOFLOW_API.inner, file);
  const extra = await runRoboflow(ROBOFLOW_API.extra, file);

  const outerBase =
    (outer && outer.predictions) ? outer.predictions.find(p => p.class === "base") : null;

  // base が取れなかったら inner をそのまま使う（フォールバック）
  if (!outerBase) {
    const fallback = inner || {};
    return {
      image: fallback.image || outer.image || extra.image || { width: 100, height: 100 },
      predictions: (fallback.predictions || []).filter(p => p.class !== "base" && p.class !== "outer")
    };
  }

  const outerBox = outerBase;

  function isInside(pred) {
    return (
      pred.x > outerBox.x - outerBox.width / 2 &&
      pred.x < outerBox.x + outerBox.width / 2 &&
      pred.y > outerBox.y - outerBox.height / 2 &&
      pred.y < outerBox.y + outerBox.height / 2
    );
  }

  function notBase(pred) {
    return pred.class !== "base" && pred.class !== "outer";
  }

  const filteredInner = (inner.predictions || []).filter(p => isInside(p) && notBase(p));
  const filteredExtra = (extra.predictions || []).filter(p => isInside(p) && notBase(p));

  let finalPreds = [outerBox, ...filteredInner];

  // extra は inner と同一クラスで IoU>0.4 なら捨てる
  filteredExtra.forEach(e => {
    let duplicate = false;
    for (let i = 0; i < filteredInner.length; i++) {
      const ii = filteredInner[i];
      if (e.class === ii.class && calcIoU(e, ii) > 0.4) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) finalPreds.push(e);
  });

  // 壁隙間補完（Wall ↔ Fusuma）
  finalPreds.push(...fillWallGaps(finalPreds, 40));

  // 優先ルール適用
  finalPreds = applyPriority(finalPreds);

  return {
    image: outer.image || inner.image || extra.image || { width: 100, height: 100 },
    predictions: finalPreds
  };
}

/* =========================
   DOMContentLoaded
   ========================= */
document.addEventListener('DOMContentLoaded', () => {
  const uploadHeader = document.getElementById('upload-header');
  const uploadContainer = document.getElementById('upload-container');
  const resultHeader = document.getElementById('result-header');
  const resultContainer = document.getElementById('result-container');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const previewImg = document.getElementById('preview');
  const resultPre = document.getElementById('result');
  const saveBtn = document.getElementById('saveBtn');
  const loadBtn = document.getElementById('loadBtn');
  const deleteBtn = document.getElementById('deleteBtn');
  const filenameInput = document.getElementById('filenameInput');
  fileSelectEl = document.getElementById('fileSelect');

  boxWEl = document.getElementById('boxW');
  boxHEl = document.getElementById('boxH');
  boxDEl = document.getElementById('boxD');
  const genBoxBtn = document.getElementById('genBoxBtn');
  placeStatusEl = document.getElementById('placeStatus');
  moveDoneBtn = document.getElementById('moveDoneBtn');
  moveDeleteBtn = document.getElementById('moveDeleteBtn');
  libraryListEl = document.getElementById('libraryList');

  function openContainer(el) {
    el.classList.remove('collapsed');
    el.classList.add('expanded');
  }
  function closeContainer(el) {
    el.classList.remove('expanded');
    el.classList.add('collapsed');
  }
  function toggleExclusive(openEl, closeEl) {
    if (openEl.classList.contains('expanded')) {
      closeContainer(openEl);
    } else {
      openContainer(openEl);
      closeContainer(closeEl);
    }
  }

  uploadHeader?.addEventListener('click', () => toggleExclusive(uploadContainer, resultContainer));
  resultHeader?.addEventListener('click', () => toggleExclusive(resultContainer, uploadContainer));

  // 画像選択
  let selectedFile = null;
  document.getElementById('imageInput').addEventListener('change', (e) => {
    selectedFile = e.target.files[0];
    if (!selectedFile) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      previewImg.src = event.target.result;
      openContainer(uploadContainer);
      closeContainer(resultContainer);
    };
    reader.readAsDataURL(selectedFile);
  });

  // ボタン横のステータス（既存UIを使用）
  let loadingText = document.getElementById('analyzeInlineStatus');
  if (!loadingText) {
    loadingText = document.createElement('span');
    loadingText.className = 'inlineStatus';
    loadingText.setAttribute('aria-live', 'polite');
    analyzeBtn.insertAdjacentElement('afterend', loadingText);
  }

  let loadingInterval = null;

  async function analyzeImage() {
    if (!selectedFile) {
      alert('画像を選択してください');
      return;
    }

    analyzeBtn.disabled = true;
    loadingText.textContent = '分析中';
    let dotCount = 0;
    loadingInterval = setInterval(() => {
      dotCount = (dotCount + 1) % 4;
      loadingText.textContent = '分析中' + '.'.repeat(dotCount);
    }, 500);

    try {
      let result;
      if (ROBOFLOW_MODE === "all") {
        result = await runAllModels(selectedFile);
      } else {
        // 一応残す（今は使わない）
        result = await runRoboflow(ROBOFLOW_API.inner, selectedFile);
      }

      clearInterval(loadingInterval);
      loadingText.textContent = '';

      latestJson = result;
      if (resultPre) {
        resultPre.textContent = JSON.stringify(result, null, 2);
      }
      openContainer(resultContainer);
      closeContainer(uploadContainer);

      const iw = result?.image?.width || 100;
      const ih = result?.image?.height || 100;
      initSceneWithFloorplan(result.predictions, iw, ih);
    } catch (err) {
      clearInterval(loadingInterval);
      loadingText.textContent = 'エラー: ' + (err.message || err);
      console.error(err);
    } finally {
      analyzeBtn.disabled = false;
    }
  }

  analyzeBtn.addEventListener('click', analyzeImage);

  // 保存
  saveBtn.addEventListener('click', () => {
    if (!accessToken || !latestJson) {
      alert('ログインまたは解析が必要です');
      return;
    }
    const filename = filenameInput.value.trim();
    if (!filename) {
      alert('保存名を入力してください');
      return;
    }
    const metadata = {
      name: `${filename}.json`,
      mimeType: 'application/json'
    };
    const file = new Blob([JSON.stringify(latestJson)], { type: 'application/json' });
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', file);

    fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: new Headers({ Authorization: 'Bearer ' + accessToken }),
      body: form
    })
      .then((res) => res.json())
      .then(() => {
        alert('保存完了');
        updateFileSelect();
      })
      .catch((err) => {
        console.error(err);
        alert('保存失敗');
      });
  });

  // 読み込み
  loadBtn.addEventListener('click', () => {
    const fileId = fileSelectEl.value;
    if (!accessToken || !fileId) {
      alert('ログインまたはファイルを選択してください');
      return;
    }
    fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: new Headers({ Authorization: 'Bearer ' + accessToken })
    })
      .then((res) => res.json())
      .then((data) => {
        latestJson = data;
        if (resultPre) {
          resultPre.textContent = JSON.stringify(data, null, 2);
        }
        openContainer(resultContainer);
        closeContainer(uploadContainer);

        const iw = data?.image?.width || 100;
        const ih = data?.image?.height || 100;
        // 旧データでも動くように：predictions をそのまま描画（baseが無ければ床はフォールバック）
        initSceneWithFloorplan(data.predictions || [], iw, ih);
      })
      .catch((err) => {
        console.error(err);
        alert('読み込みに失敗しました');
      });
  });

  // 削除
  deleteBtn.addEventListener('click', () => {
    const fileId = fileSelectEl.value;
    if (!accessToken || !fileId) {
      alert('ログインまたはファイルを選択してください');
      return;
    }
    const ok = confirm('本当にこのファイルを削除しますか？');
    if (!ok) return;

    fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
      headers: new Headers({ Authorization: 'Bearer ' + accessToken })
    })
      .then((res) => {
        if (res.status === 204) {
          alert('ファイルを削除しました');
          updateFileSelect();
        } else {
          throw new Error('削除に失敗しました');
        }
      })
      .catch((err) => {
        console.error(err);
        alert('削除エラー: ' + err.message);
      });
  });

  // 物体生成（隠しUI）
  if (genBoxBtn) {
    genBoxBtn.addEventListener('click', () => {
      const w = parseFloat(boxWEl.value || '1') || 1;
      const h = parseFloat(boxHEl.value || '1') || 1;
      const d = parseFloat(boxDEl.value || '1') || 1;
      addBoxAtCenter(w, h, d, 0x2194ce, { baseId: 'manual', name: '箱' });
    });
  }

  // 完了・削除（家具）
  if (moveDoneBtn) {
    moveDoneBtn.addEventListener('click', () => {
      selectObject(null);
    });
  }
  if (moveDeleteBtn) {
    moveDeleteBtn.addEventListener('click', () => {
      if (!selectedObject || !scene) return;
      scene.remove(selectedObject);
      draggableObjects = draggableObjects.filter((o) => o !== selectedObject);
      selectObject(null);
    });
  }

  renderFurnitureLibrary();
  window.addEventListener('storage', (e) => {
    if (e.key === FURN_STORAGE_KEY) {
      renderFurnitureLibrary();
    }
  });

  updateFileSelect();
});

/* =========================
   間取りの3Dシーン構築（床を base 優先に更新）
   ========================= */
function initSceneWithFloorplan(predictions, imageWidth, imageHeight) {
  const container = document.getElementById('three-container');
  if (!container) {
    console.error('#three-container が見つかりません');
    return;
  }

  if (renderer) {
    renderer.dispose();
    container.innerHTML = '';
  } else {
    container.innerHTML = '';
  }

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f5f5);

  camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);

  function resizeRendererToContainer() {
    const width = container.clientWidth || 640;
    const height = container.clientHeight || 600;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    threeContainerRect = container.getBoundingClientRect();
  }

  resizeRendererToContainer();
  const ro = new ResizeObserver(resizeRendererToContainer);
  ro.observe(container);
  window.addEventListener('resize', resizeRendererToContainer);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.25;
  controls.maxPolarAngle = Math.PI / 2;

  // const dir = new THREE.DirectionalLight(0xffffff, 1);
  // scene.add(dir);
  // scene.add(new THREE.AmbientLight(0x404040));
  // ===== ライト強化（見やすさ優先） =====
  scene.add(new THREE.HemisphereLight(0xffffff, 0xaaaaaa, 1.2)); // 上下から柔らかく

  scene.add(new THREE.AmbientLight(0xffffff, 0.35)); // 全体の底上げ

  // 斜め上からのキーライト
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(50, 80, 50);
  scene.add(key);

  // 反対側からのフィルライト（影を潰しすぎない）
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-60, 50, -40);
  scene.add(fill);

  // ===== wall用テクスチャ（1回だけロード）=====
  const texLoader = new THREE.TextureLoader();
  const wallBaseTex = texLoader.load('テクスチャ/kabe.jpeg');   // indexMadori.html と同階層
  wallBaseTex.colorSpace = THREE.SRGBColorSpace;     // 色がくすむの防止（three r152+）
  wallBaseTex.wrapS = THREE.RepeatWrapping;
  wallBaseTex.wrapT = THREE.RepeatWrapping;
  wallBaseTex.anisotropy = 8;                        // 斜めから見たときのにじみ軽減

  // ===== 床用テクスチャ =====
  const floorTex = texLoader.load('テクスチャ/floor.jpg');
  floorTex.colorSpace = THREE.SRGBColorSpace;
  floorTex.wrapS = THREE.RepeatWrapping;
  floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.anisotropy = 8;

  // ===== 窓用テクスチャ =====
  const windowTex = texLoader.load('テクスチャ/window.jpg');
  windowTex.colorSpace = THREE.SRGBColorSpace;
  windowTex.wrapS = THREE.RepeatWrapping;
  windowTex.wrapT = THREE.RepeatWrapping;
  windowTex.anisotropy = 8;

  // ===== クローゼット用テクスチャ =====
  const closetTex = texLoader.load('テクスチャ/closet.jpg');
  closetTex.colorSpace = THREE.SRGBColorSpace;
  closetTex.wrapS = THREE.ClampToEdgeWrapping;  // 伸ばし表示（リピートしない）
  closetTex.wrapT = THREE.ClampToEdgeWrapping;
  closetTex.anisotropy = 8;

  // ===== クローゼット上面用テクスチャ =====
  const closetTopTex = texLoader.load(
    'テクスチャ/mokume1.png',
    () => console.log('[OK] mokume1.png loaded'),
    undefined,
    (e) => console.error('[NG] mokume1.png load failed', e)
  ); // ←上面に貼りたい画像
  closetTopTex.colorSpace = THREE.SRGBColorSpace;
  closetTopTex.wrapS = THREE.ClampToEdgeWrapping; // リピートしない
  closetTopTex.wrapT = THREE.ClampToEdgeWrapping;
  closetTopTex.anisotropy = 8;

  // ===== ふすま用テクスチャ =====
  const fusumaTex = texLoader.load('テクスチャ/fusuma.jpg');
  fusumaTex.colorSpace = THREE.SRGBColorSpace;
  fusumaTex.wrapS = THREE.ClampToEdgeWrapping; // リピートしない
  fusumaTex.wrapT = THREE.ClampToEdgeWrapping;
  fusumaTex.anisotropy = 8;

  // ===== ドア用テクスチャ =====
  const doorTex = texLoader.load('テクスチャ/door.jpeg');
  doorTex.colorSpace = THREE.SRGBColorSpace;
  doorTex.wrapS = THREE.ClampToEdgeWrapping; // 引き伸ばし（リピートなし）
  doorTex.wrapT = THREE.ClampToEdgeWrapping;
  doorTex.anisotropy = 8;

  // ===== ガラスドア用テクスチャ =====
  const glassDoorTex = texLoader.load('テクスチャ/glasswindow.jpg'); // パスはあなたの構成に合わせて
  glassDoorTex.colorSpace = THREE.SRGBColorSpace;
  glassDoorTex.wrapS = THREE.ClampToEdgeWrapping; // リピートしない（引き伸ばし）
  glassDoorTex.wrapT = THREE.ClampToEdgeWrapping;
  glassDoorTex.anisotropy = 8;










  // 現行のスケールは維持（UI変更なし方針）
  const scale = 0.1;

  // --- 床：base があれば base で床を作る。無ければ画像全体床（従来フォールバック） ---
  const baseObj = (predictions || []).find(p => p.class === "base");
  let floorW, floorH, floorX, floorZ;

  if (baseObj) {
    floorW = baseObj.width * scale;
    floorH = baseObj.height * scale;
    floorX = (baseObj.x - imageWidth / 2) * scale;
    floorZ = -(baseObj.y - imageHeight / 2) * scale;
  } else {
    floorW = imageWidth * scale;
    floorH = imageHeight * scale;
    floorX = 0;
    floorZ = 0;
  }

  // テクスチャの繰り返し回数（「2mで1回」くらい。好みで調整）
  floorTex.repeat.set(Math.max(1, floorW / 10.0), Math.max(1, floorH / 10.0));

  const floorGeometry = new THREE.PlaneGeometry(floorW, floorH);
  const floorMaterial = new THREE.MeshLambertMaterial({
    map: floorTex,
    color: 0xffffff
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);

  floor.rotation.x = -Math.PI / 2;
  floor.position.set(floorX, 0, floorZ);
  scene.add(floor);

  // --- カメラ調整（従来の「平べったい」を避けるロジックは維持） ---
  const sceneSize = Math.max(floorW, floorH);
  camera.far = Math.max(1000, sceneSize * 10);
  camera.updateProjectionMatrix();
  camera.position.set(sceneSize * 0.8, sceneSize * 0.8, sceneSize * 0.8);
  camera.lookAt(0, 0, 0);

  controls.target.set(0, 0, 0);
  controls.maxDistance = sceneSize * 5;
  controls.update();

  key.position.set(sceneSize * 0.35, sceneSize * 0.8, sceneSize * 0.55);
  key.target.position.set(0, 0, 0);
  scene.add(key.target);


  // --- 描画（base/outer/sideは無視。priorityを適用してから描画） ---
  const classColors = {
    wall: 0x999999,
    door: 0x8b4513,
    'glass door': 0x87cefa,
    window: 0x1e90ff,
    closet: 0xffa500,
    fusuma: 0xda70d6
  };
  const ignoreList = ['left side', 'right side', 'under side', 'top side', 'base', 'outer'];

  let drawPreds = (predictions || []).filter(p => !ignoreList.includes(p.class));
  drawPreds = applyPriority(drawPreds);

  drawPreds.forEach((pred) => {
    const geometry = new THREE.BoxGeometry(
      pred.width * scale,
      2.4,
      pred.height * scale
    );
    let material;

    if (pred.class === "wall") {
      // 壁ごとに repeat を変えたいので clone を作る
      const t = wallBaseTex.clone();
      t.needsUpdate = true;

      // だいたい「10mごとに1回繰り返す」くらいの感覚（好みで調整OK）
      const wallW = pred.width * scale;   // X方向
      const wallH = 2.4;                  // 壁高さ
      t.repeat.set(Math.max(1, wallW / 2.0), Math.max(1, wallH / 2.0));

      material = new THREE.MeshLambertMaterial({
        map: t,
        color: 0xffffff // テクスチャの色をそのまま出す
      });

    } else if (pred.class === "window") {
      const t = windowTex.clone();
      t.needsUpdate = true;

      const w = pred.width * scale; // X方向
      const h = 2.4;                // 壁高さ（今の実装に合わせる）
      // ★リピートしない（1枚を引き延ばす）
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.repeat.set(1, 1);
      t.offset.set(0, 0);

      material = new THREE.MeshLambertMaterial({
        map: t,
        color: 0xffffff,
        transparent: true,
        opacity: 0.75,              // ガラスっぽさ（好みで0.6〜0.9）
        depthWrite: false,          // 透明の表示崩れを減らす
        side: THREE.DoubleSide      // 両面見えるように
      });
    } else if (pred.class === "closet") {
      // 側面（クローゼット画像）
      const sideT = closetTex.clone();
      sideT.needsUpdate = true;
      sideT.wrapS = THREE.ClampToEdgeWrapping;
      sideT.wrapT = THREE.ClampToEdgeWrapping;
      sideT.repeat.set(1, 1);
      sideT.offset.set(0, 0);
      sideT.anisotropy = 16;

      // 上面（木目）
      const topT = closetTopTex.clone();
      topT.needsUpdate = true;
      topT.wrapS = THREE.ClampToEdgeWrapping;
      topT.wrapT = THREE.ClampToEdgeWrapping;
      topT.repeat.set(1, 1);
      topT.offset.set(0, 0);
      topT.anisotropy = 16;

      // 木目の向きが合わないときはコメント解除
      // topT.center.set(0.5, 0.5);
      // topT.rotation = Math.PI / 2;

      // BoxGeometry の面順: right, left, top, bottom, front, back
      const mSide = new THREE.MeshLambertMaterial({
        map: sideT,
        color: 0xffffff,
        side: THREE.DoubleSide
      });

      const mTop = new THREE.MeshLambertMaterial({
        map: topT,
        color: 0xffffff,
        side: THREE.DoubleSide
      });
      material = [mSide, mSide, mTop, mSide, mSide, mSide];

      // 底面は床に接してほぼ見えないので側面と同じでOK
      material = [mSide, mSide, mTop, mSide, mSide, mSide];
    } else if (pred.class === "fusuma") {
      const t = fusumaTex.clone();
      t.needsUpdate = true;

      // ★リピートしない（1枚を引き延ばす）
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.repeat.set(1, 1);
      t.offset.set(0, 0);
      t.anisotropy = 16;

      material = new THREE.MeshLambertMaterial({
        map: t,
        color: 0xffffff,
        side: THREE.DoubleSide
      });
    } else if (pred.class === "door") {
      // 側面用（door.jpeg）
      const sideT = doorTex.clone();
      sideT.needsUpdate = true;
      sideT.wrapS = THREE.ClampToEdgeWrapping;
      sideT.wrapT = THREE.ClampToEdgeWrapping;
      sideT.repeat.set(1, 1);
      sideT.offset.set(0, 0);
      sideT.anisotropy = 16;

      // 上面用（mokume1.png）※クローゼット上面と同じテクスチャを流用
      const topT = closetTopTex.clone();
      topT.needsUpdate = true;
      topT.wrapS = THREE.ClampToEdgeWrapping;
      topT.wrapT = THREE.ClampToEdgeWrapping;
      topT.repeat.set(1, 1);
      topT.offset.set(0, 0);
      topT.anisotropy = 16;

      const mSide = new THREE.MeshLambertMaterial({
        map: sideT,
        color: 0xffffff,
        side: THREE.DoubleSide
      });

      const mTop = new THREE.MeshLambertMaterial({
        map: topT,
        color: 0xffffff,
        side: THREE.DoubleSide
      });
      material = [mSide, mSide, mTop, mSide, mSide, mSide]; // right,left,top,bottom,front,back


    } else if (pred.class === "glass door") {
      const t = glassDoorTex.clone();
      t.needsUpdate = true;

      // ★リピートしない（1枚を引き延ばす）
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.repeat.set(1, 1);
      t.offset.set(0, 0);
      t.anisotropy = 16;

      material = new THREE.MeshLambertMaterial({
        map: t,
        color: 0xffffff,
        transparent: true,
        opacity: 0.75,        // ガラス感（0.6〜0.9で調整）
        depthWrite: false,    // 透明の表示崩れを減らす
        side: THREE.DoubleSide
      });
    } else {
      const color = classColors[pred.class] || 0xffffff;
      material = new THREE.MeshLambertMaterial({ color });
    }

    const mesh = new THREE.Mesh(geometry, material);


    mesh.position.x = (pred.x - imageWidth / 2) * scale;
    mesh.position.y = 2.4 / 2;
    mesh.position.z = -(pred.y - imageHeight / 2) * scale;

    scene.add(mesh);

  });

  // --- ドラッグ周りのセットアップ ---
  draggableObjects = [];
  selectedObject = null;
  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  dragOffset = new THREE.Vector3();
  dragIntersectPoint = new THREE.Vector3();
  threeContainerRect = container.getBoundingClientRect();
  isDragging = false;

  const dom = renderer.domElement;
  dom.addEventListener('dblclick', onDoubleClick);
  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerup', onPointerUp);

  (function animate() {
    requestAnimationFrame(animate);
    if (controls) controls.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
  })();
}
