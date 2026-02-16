import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let accessToken = null;
let latestJson = null;

/* =========================
   Roboflow settings
   ========================= */
// 3モデル（newscript.js の構成を移植）
const ROBOFLOW_API = {
  outer: "https://detect.roboflow.com/floor-plan-japan-base-6xuaz/2?api_key=E0aoexJvBDgvE3nb1jkc",
  inner: "https://detect.roboflow.com/floor-plan-japan/7?api_key=E0aoexJvBDgvE3nb1jkc",
  extra: "https://detect.roboflow.com/floor-plan-japan-2-menv0/1?api_key=E0aoexJvBDgvE3nb1jkc&confidence=0.25"
};

// 常に 3モデル合成を使う
const ROBOFLOW_MODE = "all";

/* ========== Furniture presets (shared with 家具生成タブ) ========== */
const FURN_STORAGE_KEY = 'madomake_furniturePresets';

/* ========== GLB model paths (relative to 間取り図/indexMadori.html) ========== */
const GLB_PATHS = {
  desk: '../家具生成/机.glb',
  sofa: '../家具生成/ソファ.glb',
  bed: '../家具生成/bed.glb',
  chair: '../家具生成/椅子.glb'
};

// プリセット
const DEFAULT_PRESETS = [
  { baseId: 'desk', name: '机', size: { x: 1.2, y: 0.7, z: 0.6 } },
  { baseId: 'chair', name: 'イス', size: { x: 0.5, y: 0.8, z: 0.5 } },
  { baseId: 'sofa', name: 'ソファ', size: { x: 1.8, y: 0.8, z: 0.8 } },
  { baseId: 'bed', name: 'ベッド', size: { x: 1.2, y: 0.5, z: 2.0 } },
];

const gltfLoader = new GLTFLoader();

/* ========== Three.js globals ========== */
let scene = null;
let camera = null;
let renderer = null;
let controls = null;

/* ========== Drag / select / rotate globals ========== */
let raycaster = null;
let pointer = null;
let dragPlane = null;
let dragOffset = null;
let dragIntersectPoint = null;
let draggableObjects = [];
let selectedObject = null;
let isDragging = false;
let threeContainerRect = null;

// 回転機能用変数
let rotationGizmo = null;   // 回転用の円弧オブジェクト
let isRotating = false;     // 回転操作中かどうかのフラグ
let startMouseAngle = 0;    // 回転開始時のマウス角度
let startObjectRotation = 0;// 回転開始時の家具角度

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
  console.log('Googleログイン成功'); requestAccessToken();
}
window.handleCredentialResponse = handleCredentialResponse;

function requestAccessToken() {
  google.accounts.oauth2.initTokenClient({
    client_id: '479474446026-kej6f40kvfm6dsuvfeo5d4fm87c6god4.apps.googleusercontent.com',
    scope: 'https://www.googleapis.com/auth/drive.file', callback: (tokenResponse) => {
      accessToken = tokenResponse.access_token; console.log('アクセストークン取得済'); updateFileSelect();
    }
  }).requestAccessToken();
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

/* プリセット（標準家具）の描画 */
function renderDefaultPresets() {
  const container = document.getElementById('defaultList');
  if (!container) return;

  container.innerHTML = '';
  DEFAULT_PRESETS.forEach((preset) => {
    const btn = document.createElement('button');
    btn.className = 'libItemBtn';
    btn.textContent = preset.name;

    btn.addEventListener('click', () => {
      spawnFurnitureFromPreset(preset);
    });
    container.appendChild(btn);
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
        o.userData.isObstacle = true;
        o.userData.class = 'furniture';
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

    // --- Color restore ---
    const meshColors =
      (preset && typeof preset.meshColors === 'object' && preset.meshColors) ? preset.meshColors : null;
    let meshIndex = 0;
    const applyColorToMaterial = (mat, colorStrOrHex) => {
      if (!mat || !('color' in mat)) return;
      if (typeof colorStrOrHex === 'number') mat.color.setHex(colorStrOrHex);
      else mat.color.set(colorStrOrHex);
      mat.needsUpdate = true;
    };

    root.traverse((o) => {
      if (!o.isMesh) return;

      // Break shared material references
      if (o.material) {
        if (Array.isArray(o.material)) o.material = o.material.map((m) => m.clone());
        else o.material = o.material.clone();
      }

      if (meshColors) {
        const key = `${meshIndex}:${(o.name || '').trim()}`;
        const c = meshColors[key];
        if (c) {
          if (Array.isArray(o.material)) o.material.forEach((m) => applyColorToMaterial(m, c));
          else applyColorToMaterial(o.material, c);
        }
      } else if (baseId !== 'bed') {
        if (preset.color) {
          if (Array.isArray(o.material)) o.material.forEach((m) => applyColorToMaterial(m, colorHex));
          else applyColorToMaterial(o.material, colorHex);
        }
      }
      meshIndex++;
    });

    root.userData.draggable = true;
    root.userData.isObstacle = true;
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
  mesh.userData.isObstacle = true;
  mesh.userData.baseId = meta.baseId || 'generic';
  mesh.userData.label = meta.name || '箱';

  scene.add(mesh);
  draggableObjects.push(mesh);
  selectObject(mesh);
}

/* =========================
   回転　円弧+矢印
   ========================= */
function createRotationGizmo(targetObj) {
  if (!targetObj) return null;

  // 半径
  const bbox = new THREE.Box3().setFromObject(targetObj);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const radius = Math.max(size.x, size.z) * 0.7; // 家具より一回り大きく

  // 設定
  const tube = 0.05;          // 円弧の太さ（半径方向の幅の半分）
  const arrowLen = tube * 6;  // 矢印の長さ
  const arrowRad = tube * 2.5; // 矢印の太さ（底面の半径）

  const group = new THREE.Group();
  group.userData.isGizmo = true;

  // 3. 角度設定 (4時〜8時 = 手前側)
  // Three.jsのRingGeometryは 3時(0度) スタートで反時計回り
  // 4時 = 330度 (-30度) 
  // 8時 = 210度 (-150度)
  // ここでは RingGeometry の仕様に合わせて 210度〜330度 の範囲で描画
  const startRad = 210 * (Math.PI / 180); // 7π/6
  const endRad = 330 * (Math.PI / 180);   // 11π/6
  const lenRad = endRad - startRad;       // 120度 (2π/3)

  // 円弧
  const arcGeo = new THREE.RingGeometry(radius - tube, radius + tube, 64, 1, startRad, lenRad);
  // X軸で-90度回転させて床に寝かせる (頂点座標の Y が -Z に、Z が Y になる)
  // これにより、Ringの「3時」がワールドの「+X」、「12時」が「-Z(奥)」に
  arcGeo.rotateX(-Math.PI / 2);

  const mat = new THREE.MeshBasicMaterial({
    color: 0x1e90ff,
    side: THREE.DoubleSide,
    depthTest: false,
    transparent: true,
    opacity: 0.8
  });

  const arcMesh = new THREE.Mesh(arcGeo, mat);
  arcMesh.userData.isGizmoPart = true;
  group.add(arcMesh);

  // 判定用透明リング (当たり判定拡大) ---
  const hitTube = 0.2;
  const hitGeo = new THREE.RingGeometry(radius - hitTube, radius + hitTube, 32, 1, startRad, lenRad);
  hitGeo.rotateX(-Math.PI / 2);
  const hitMat = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    visible: true,      // Raycaster用
    transparent: true,
    opacity: 0,         // 透明
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const hitMesh = new THREE.Mesh(hitGeo, hitMat);
  hitMesh.userData.isGizmoPart = true;
  group.add(hitMesh);

  // 矢印
  function createArrow(angleRad, isClockwise) {
    // 1. 円弧の端点の座標 (ワールド座標系: Y=0平面)
    // RingGeometry(x, y) -> rotateX(-90) -> (x, 0, -y)
    // x = R * cos(theta), z = - R * sin(theta)
    const px = radius * Math.cos(angleRad);
    const pz = -radius * Math.sin(angleRad);
    const pos = new THREE.Vector3(px, 0, pz);

    // 2. 接線ベクトル (矢印の向き)
    // 円周の接線は (dx/dθ, dz/dθ) = (-R sin, -R cos)
    // 反時計回り(CCW)方向ベクトル
    const tanX = -radius * Math.sin(angleRad);
    const tanZ = -radius * Math.cos(angleRad);
    let dir = new THREE.Vector3(tanX, 0, tanZ).normalize();

    // 時計回りの場合は逆向きに
    if (isClockwise) {
      dir.negate();
    }

    const coneGeo = new THREE.ConeGeometry(arrowRad, arrowLen, 16);
    coneGeo.rotateX(-Math.PI / 2); // 先端を -Z (奥) 、底面を +Z (手前) 

    const arrow = new THREE.Mesh(coneGeo, mat);
    const centerPos = pos.clone().add(dir.clone().multiplyScalar(arrowLen / 2));
    arrow.position.copy(centerPos);
    const target = centerPos.clone().add(dir);
    arrow.lookAt(target);
    arrow.userData.isGizmoPart = true;
    return arrow;
  }

  // 左端 (Start: 210度) -> 時計回り(CW)向きの矢印
  const arrowL = createArrow(startRad, true);
  group.add(arrowL);

  // 右端 (End: 330度) -> 反時計回り(CCW)向きの矢印
  const arrowR = createArrow(endRad, false);
  group.add(arrowR);

  return group;
}

function updateGizmoPosition() {
  if (rotationGizmo && selectedObject) {
    rotationGizmo.position.copy(selectedObject.position);
    rotationGizmo.position.y = 0.02;
    rotationGizmo.rotation.y = selectedObject.rotation.y;
  }
}

/* 選択状態の更新 */
function selectObject(obj) {
  selectedObject = obj || null;

  if (rotationGizmo) {
    scene.remove(rotationGizmo);
    rotationGizmo = null;
  }

  if (placeStatusEl) {
    if (!selectedObject) {
      placeStatusEl.textContent = '未選択';
    } else {
      const label = selectedObject.userData?.label || '箱';
      placeStatusEl.textContent = '選択中：' + label;

      rotationGizmo = createRotationGizmo(selectedObject);
      if (rotationGizmo) {
        scene.add(rotationGizmo);
        updateGizmoPosition();
      }
    }
  }
  if (moveDoneBtn) moveDoneBtn.disabled = !selectedObject;
  if (moveDeleteBtn) moveDeleteBtn.disabled = !selectedObject;
}

/* =========================
   Raycast / Drag / Rotate
   ========================= */
function updatePointerFromEvent(event) {
  if (!renderer) return;
  const rect = renderer.domElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  if (!threeContainerRect) {
    const container = document.getElementById('three-container');
    threeContainerRect = container.getBoundingClientRect();
  }
  const x = ((event.clientX - threeContainerRect.left) / threeContainerRect.width) * 2 - 1;
  const y = -((event.clientY - threeContainerRect.top) / threeContainerRect.height) * 2 + 1;
  pointer.set(x, y);
}

// ギズモをクリックしたか判定
function pickGizmo(event) {
  if (!rotationGizmo || !raycaster || !camera) return false;
  updatePointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);
  // trueを指定して子要素（透明なヒットエリア含む）も判定
  const hits = raycaster.intersectObject(rotationGizmo, true);
  return hits.length > 0;
}

function pickObject(event) {
  if (!raycaster || !camera || !scene) return null;
  if (!draggableObjects || draggableObjects.length === 0) return null;
  updatePointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);

  const hits = raycaster.intersectObjects(scene.children, true);
  if (!hits.length) return null;

  for (const hit of hits) {
    if (hit.object.userData.isGizmo || hit.object.userData.isGizmoPart || hit.object.parent?.userData?.isGizmo) {
      continue;
    }
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
  event.preventDefault();
  if (pickGizmo(event)) return;

  const obj = pickObject(event);
  if (obj) selectObject(obj);
  else selectObject(null);
}

function onPointerDown(event) {
  if (event.button !== 0) return;

  // 1. 回転判定（透明エリア含めて広範囲でチェック）
  if (selectedObject && rotationGizmo && pickGizmo(event)) {
    isRotating = true;
    isDragging = false;
    if (controls) controls.enabled = false;
    renderer.domElement.setPointerCapture?.(event.pointerId);

    updatePointerFromEvent(event);
    raycaster.setFromCamera(pointer, camera);
    dragPlane.set(new THREE.Vector3(0, 1, 0), -selectedObject.position.y);

    if (raycaster.ray.intersectPlane(dragPlane, dragIntersectPoint)) {
      const cx = selectedObject.position.x;
      const cz = selectedObject.position.z;
      const mx = dragIntersectPoint.x;
      const mz = dragIntersectPoint.z;
      startMouseAngle = Math.atan2(mx - cx, mz - cz);
      startObjectRotation = selectedObject.rotation.y;
    }

    if (placeStatusEl) placeStatusEl.textContent = '回転中...';
    return;
  }

  // 2. 移動判定
  const obj = pickObject(event);
  if (obj && obj === selectedObject) {
    isDragging = true;
    isRotating = false;
    renderer.domElement.setPointerCapture?.(event.pointerId);
    updatePointerFromEvent(event);
    raycaster.setFromCamera(pointer, camera);

    dragPlane.set(new THREE.Vector3(0, 1, 0), -selectedObject.position.y);
    if (raycaster.ray.intersectPlane(dragPlane, dragIntersectPoint)) {
      dragOffset.subVectors(selectedObject.position, dragIntersectPoint);
    } else {
      isDragging = false;
      renderer.domElement.releasePointerCapture?.(event.pointerId);
      return;
    }
    if (controls) controls.enabled = false;
    if (placeStatusEl) placeStatusEl.textContent = '移動中…';
  }
}

function onPointerMove(event) {
  if (!selectedObject) return;

  // 回転
  if (isRotating) {
    updatePointerFromEvent(event);
    raycaster.setFromCamera(pointer, camera);

    if (raycaster.ray.intersectPlane(dragPlane, dragIntersectPoint)) {
      const cx = selectedObject.position.x;
      const cz = selectedObject.position.z;
      const mx = dragIntersectPoint.x;
      const mz = dragIntersectPoint.z;

      const currentMouseAngle = Math.atan2(mx - cx, mz - cz);
      const diff = currentMouseAngle - startMouseAngle;
      selectedObject.rotation.y = startObjectRotation + diff;

      updateGizmoPosition();
    }
    return;
  }

  // 移動
  if (isDragging) {
    updatePointerFromEvent(event);
    raycaster.setFromCamera(pointer, camera);

    if (raycaster.ray.intersectPlane(dragPlane, dragIntersectPoint)) {
      const newPos = new THREE.Vector3().copy(dragIntersectPoint).add(dragOffset);
      const gridStep = 0.1;
      selectedObject.position.x = Math.round(newPos.x / gridStep) * gridStep;
      selectedObject.position.z = Math.round(newPos.z / gridStep) * gridStep;

      checkCollisions();
      updateGizmoPosition();
    }
  }
}

function checkCollisions() {
  if (!selectedObject) return;
  const selectedBox = new THREE.Box3().setFromObject(selectedObject);
  selectedBox.min.y += 0.01;
  let isColliding = false;

  scene.traverse((other) => {
    if (!other.isMesh || !other.userData.isObstacle) return;
    if (other.userData.isGizmoPart || other.parent?.userData?.isGizmo) return;

    let isSelf = false;
    other.traverseAncestors((ancestor) => {
      if (ancestor === selectedObject) isSelf = true;
    });
    if (isSelf) return;

    const otherBox = new THREE.Box3().setFromObject(other);
    if (selectedBox.intersectsBox(otherBox)) {
      isColliding = true;
    }
  });

  selectedObject.traverse((node) => {
    if (node.isMesh && node.material) {
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      mats.forEach(m => {
        if (isColliding) {
          m.emissive.setHex(0xff0000);
          m.emissiveIntensity = 0.5;
        } else {
          m.emissive.setHex(0x000000);
          m.emissiveIntensity = 0;
        }
      });
    }
  });
}

function onPointerUp() {
  if (isDragging || isRotating) {
    isDragging = false;
    isRotating = false;
    if (controls) controls.enabled = true;
    if (placeStatusEl && selectedObject) {
      const label = selectedObject.userData?.label || '箱';
      placeStatusEl.textContent = '選択中：' + label;
    }
  }
}

/* =========================
   Google Drive Files
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
   Roboflow Logic
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

function fillWallGaps(preds, maxDist = 40) {
  const walls = preds.filter(p => p.class === "wall" || p.class === "fusuma");
  const filled = [];

  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const a = walls[i];
      const b = walls[j];
      const isPair = (a.class === "wall" && b.class === "fusuma") || (a.class === "fusuma" && b.class === "wall");
      if (!isPair) continue;

      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < maxDist) {
        filled.push({
          class: "wall",
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          width: Math.max(4, Math.abs(a.x - b.x) + 4),
          height: Math.max(4, Math.abs(a.y - b.y) + 4),
          confidence: 0.99
        });
      }
    }
  }
  return filled;
}

function applyPriority(preds) {
  const result = [];
  const items = preds.slice();

  items.forEach(p => {
    if (p.class === "base" || p.class === "outer") {
      result.push(p);
      return;
    }
    let skip = false;
    for (let k = 0; k < items.length; k++) {
      const other = items[k];
      if (p === other) continue;
      if (other.class === "base" || other.class === "outer") continue;
      if (calcIoU(p, other) < 0.15) continue;
      if ((p.class === "closet" || p.class === "door") && other.class === "wall") { skip = true; break; }
      if (p.class === "wall" && (other.class === "window" || other.class === "glass door")) { skip = true; break; }
      if (p.class === other.class && calcIoU(p, other) > 0.6 && (p.confidence || 0) < (other.confidence || 0)) { skip = true; break; }
    }
    if (!skip) result.push(p);
  });
  return result;
}

async function runAllModels(file) {
  const outer = await runRoboflow(ROBOFLOW_API.outer, file);
  const inner = await runRoboflow(ROBOFLOW_API.inner, file);
  const extra = await runRoboflow(ROBOFLOW_API.extra, file);

  const outerBase = (outer && outer.predictions) ? outer.predictions.find(p => p.class === "base") : null;
  if (!outerBase) {
    const fallback = inner || {};
    return {
      image: fallback.image || outer.image || extra.image || { width: 100, height: 100 },
      predictions: (fallback.predictions || []).filter(p => p.class !== "base" && p.class !== "outer")
    };
  }

  const outerBox = outerBase;
  const isInside = (pred) => (pred.x > outerBox.x - outerBox.width / 2 && pred.x < outerBox.x + outerBox.width / 2 && pred.y > outerBox.y - outerBox.height / 2 && pred.y < outerBox.y + outerBox.height / 2);
  const notBase = (pred) => pred.class !== "base" && pred.class !== "outer";
  const filteredInner = (inner.predictions || []).filter(p => isInside(p) && notBase(p));
  const filteredExtra = (extra.predictions || []).filter(p => isInside(p) && notBase(p));
  let finalPreds = [outerBox, ...filteredInner];
  filteredExtra.forEach(e => {
    let duplicate = false;
    for (const ii of filteredInner) {
      if (e.class === ii.class && calcIoU(e, ii) > 0.4) { duplicate = true; break; }
    }
    if (!duplicate) finalPreds.push(e);
  });
  finalPreds.push(...fillWallGaps(finalPreds, 40));
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
  function openContainer(el) { el.classList.remove('collapsed'); el.classList.add('expanded'); }
  function closeContainer(el) { el.classList.remove('expanded'); el.classList.add('collapsed'); }
  function toggleExclusive(openEl, closeEl) {
    if (openEl.classList.contains('expanded')) { closeContainer(openEl); }
    else { openContainer(openEl); closeContainer(closeEl); }
  }

  uploadHeader?.addEventListener('click', () => toggleExclusive(uploadContainer, resultContainer));
  resultHeader?.addEventListener('click', () => toggleExclusive(resultContainer, uploadContainer));

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
  let loadingText = document.getElementById('analyzeInlineStatus');
  if (!loadingText) {
    loadingText = document.createElement('span');
    loadingText.className = 'inlineStatus';
    loadingText.setAttribute('aria-live', 'polite');
    analyzeBtn.insertAdjacentElement('afterend', loadingText);
  }
  let loadingInterval = null;
  async function analyzeImage() {
    if (!selectedFile) { alert('画像を選択してください'); return; }
    analyzeBtn.disabled = true;
    loadingText.textContent = '分析中';
    let dotCount = 0;
    loadingInterval = setInterval(() => { dotCount = (dotCount + 1) % 4; loadingText.textContent = '分析中' + '.'.repeat(dotCount); }, 500);
    try {
      let result;
      if (ROBOFLOW_MODE === "all") result = await runAllModels(selectedFile);
      else result = await runRoboflow(ROBOFLOW_API.inner, selectedFile);
      clearInterval(loadingInterval);
      loadingText.textContent = '';
      latestJson = result;
      if (resultPre) resultPre.textContent = JSON.stringify(result, null, 2);
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

  saveBtn.addEventListener('click', () => {
    if (!accessToken || !latestJson) { alert('ログインまたは解析が必要です'); return; }
    const filename = filenameInput.value.trim();
    if (!filename) { alert('保存名を入力してください'); return; }
    const metadata = { name: `${filename}.json`, mimeType: 'application/json' };
    const file = new Blob([JSON.stringify(latestJson)], { type: 'application/json' });
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', file);
    fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: new Headers({ Authorization: 'Bearer ' + accessToken }),
      body: form
    }).then((res) => res.json()).then(() => { alert('保存完了'); updateFileSelect(); }).catch((err) => { console.error(err); alert('保存失敗'); });
  });

  loadBtn.addEventListener('click', () => {
    const fileId = fileSelectEl.value;
    if (!accessToken || !fileId) { alert('ログインまたはファイルを選択してください'); return; }
    fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: new Headers({ Authorization: 'Bearer ' + accessToken })
    }).then((res) => res.json()).then((data) => {
      latestJson = data;
      if (resultPre) resultPre.textContent = JSON.stringify(data, null, 2);
      openContainer(resultContainer);
      closeContainer(uploadContainer);
      const iw = data?.image?.width || 100;
      const ih = data?.image?.height || 100;
      initSceneWithFloorplan(data.predictions || [], iw, ih);
    }).catch((err) => { console.error(err); alert('読み込みに失敗しました'); });
  });

  deleteBtn.addEventListener('click', () => {
    const fileId = fileSelectEl.value;
    if (!accessToken || !fileId) { alert('ログインまたはファイルを選択してください'); return; }
    if (!confirm('本当にこのファイルを削除しますか？')) return;
    fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
      headers: new Headers({ Authorization: 'Bearer ' + accessToken })
    }).then((res) => {
      if (res.status === 204) { alert('ファイルを削除しました'); updateFileSelect(); }
      else throw new Error('削除に失敗しました');
    }).catch((err) => { console.error(err); alert('削除エラー: ' + err.message); });
  });

  if (genBoxBtn) {
    genBoxBtn.addEventListener('click', () => {
      const w = parseFloat(boxWEl.value || '1') || 1;
      const h = parseFloat(boxHEl.value || '1') || 1;
      const d = parseFloat(boxDEl.value || '1') || 1;
      addBoxAtCenter(w, h, d, 0x2194ce, { baseId: 'manual', name: '箱' });
    });
  }

  if (moveDoneBtn) {
    moveDoneBtn.addEventListener('click', () => selectObject(null));
  }
  if (moveDeleteBtn) {
    moveDeleteBtn.addEventListener('click', () => {
      if (!selectedObject || !scene) return;
      if (rotationGizmo) { scene.remove(rotationGizmo); rotationGizmo = null; }
      scene.remove(selectedObject);
      draggableObjects = draggableObjects.filter((o) => o !== selectedObject);
      selectObject(null);
    });
  }

  document.addEventListener('keydown', (e) => {
    if (!selectedObject) return;
    if (e.key.toLowerCase() === 'r') {
      selectedObject.rotation.y += Math.PI / 2;
      updateGizmoPosition();
      if (placeStatusEl) {
        const label = selectedObject.userData?.label || '箱';
        placeStatusEl.textContent = `選択中：${label} (回転済み)`;
      }
    }
    if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) {
      moveDeleteBtn.click();
    }
  });

  renderFurnitureLibrary();
  renderDefaultPresets();
  window.addEventListener('storage', (e) => {
    if (e.key === FURN_STORAGE_KEY) { renderFurnitureLibrary(); renderDefaultPresets(); }
  });
  updateFileSelect();
});

/* =========================
   3D Scene
   ========================= */
function initSceneWithFloorplan(predictions, imageWidth, imageHeight) {
  const container = document.getElementById('three-container');
  if (!container) return;
  if (renderer) { renderer.dispose(); container.innerHTML = ''; } else { container.innerHTML = ''; }

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

  scene.add(new THREE.HemisphereLight(0xffffff, 0xaaaaaa, 1.2));
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(50, 80, 50);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-60, 50, -40);
  scene.add(fill);

  const texLoader = new THREE.TextureLoader();
  const wallBaseTex = texLoader.load('テクスチャ/kabe.jpeg');
  wallBaseTex.colorSpace = THREE.SRGBColorSpace; wallBaseTex.wrapS = THREE.RepeatWrapping; wallBaseTex.wrapT = THREE.RepeatWrapping; wallBaseTex.anisotropy = 8;
  const floorTex = texLoader.load('テクスチャ/floor.jpg');
  floorTex.colorSpace = THREE.SRGBColorSpace; floorTex.wrapS = THREE.RepeatWrapping; floorTex.wrapT = THREE.RepeatWrapping; floorTex.anisotropy = 8;
  const windowTex = texLoader.load('テクスチャ/window.jpg');
  windowTex.colorSpace = THREE.SRGBColorSpace; windowTex.wrapS = THREE.RepeatWrapping; windowTex.wrapT = THREE.RepeatWrapping; windowTex.anisotropy = 8;
  const closetTex = texLoader.load('テクスチャ/closet.jpg');
  closetTex.colorSpace = THREE.SRGBColorSpace; closetTex.wrapS = THREE.ClampToEdgeWrapping; closetTex.wrapT = THREE.ClampToEdgeWrapping; closetTex.anisotropy = 8;
  const closetTopTex = texLoader.load('テクスチャ/mokume1.png');
  closetTopTex.colorSpace = THREE.SRGBColorSpace; closetTopTex.wrapS = THREE.ClampToEdgeWrapping; closetTopTex.wrapT = THREE.ClampToEdgeWrapping; closetTopTex.anisotropy = 8;
  const fusumaTex = texLoader.load('テクスチャ/fusuma.jpg');
  fusumaTex.colorSpace = THREE.SRGBColorSpace; fusumaTex.wrapS = THREE.ClampToEdgeWrapping; fusumaTex.wrapT = THREE.ClampToEdgeWrapping; fusumaTex.anisotropy = 8;
  const doorTex = texLoader.load('テクスチャ/door.jpeg');
  doorTex.colorSpace = THREE.SRGBColorSpace; doorTex.wrapS = THREE.ClampToEdgeWrapping; doorTex.wrapT = THREE.ClampToEdgeWrapping; doorTex.anisotropy = 8;
  const glassDoorTex = texLoader.load('テクスチャ/glasswindow.jpg');
  glassDoorTex.colorSpace = THREE.SRGBColorSpace; glassDoorTex.wrapS = THREE.ClampToEdgeWrapping; glassDoorTex.wrapT = THREE.ClampToEdgeWrapping; glassDoorTex.anisotropy = 8;

  const scale = 0.1;
  const baseObj = (predictions || []).find(p => p.class === "base");
  let floorW, floorH, floorX, floorZ;
  if (baseObj) {
    floorW = baseObj.width * scale; floorH = baseObj.height * scale;
    floorX = (baseObj.x - imageWidth / 2) * scale; floorZ = -(baseObj.y - imageHeight / 2) * scale;
  } else {
    floorW = imageWidth * scale; floorH = imageHeight * scale; floorX = 0; floorZ = 0;
  }
  floorTex.repeat.set(Math.max(1, floorW / 10.0), Math.max(1, floorH / 10.0));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorW, floorH), new THREE.MeshLambertMaterial({ map: floorTex, color: 0xffffff }));
  floor.rotation.x = -Math.PI / 2;
  floor.name = "FLOOR_MESH";
  scene.add(floor);

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

  const classColors = { wall: 0x999999, door: 0x8b4513, 'glass door': 0x87cefa, window: 0x1e90ff, closet: 0xffa500, fusuma: 0xda70d6 };
  const ignoreList = ['left side', 'right side', 'under side', 'top side', 'base', 'outer'];
  let drawPreds = (predictions || []).filter(p => !ignoreList.includes(p.class));
  drawPreds = applyPriority(drawPreds);

  drawPreds.forEach((pred) => {
    const geometry = new THREE.BoxGeometry(pred.width * scale, 2.4, pred.height * scale);
    let material;
    if (pred.class === "wall") {
      const t = wallBaseTex.clone(); t.needsUpdate = true;
      t.repeat.set(Math.max(1, (pred.width * scale) / 2.0), Math.max(1, 1.2));
      material = new THREE.MeshLambertMaterial({ map: t, color: 0xffffff });
    } else if (pred.class === "window") {
      const t = windowTex.clone(); t.needsUpdate = true;
      t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.repeat.set(1, 1);
      material = new THREE.MeshLambertMaterial({ map: t, color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide });
    } else if (pred.class === "closet") {
      const sideT = closetTex.clone(); sideT.needsUpdate = true;
      sideT.wrapS = THREE.ClampToEdgeWrapping; sideT.wrapT = THREE.ClampToEdgeWrapping; sideT.repeat.set(1, 1);
      const topT = closetTopTex.clone(); topT.needsUpdate = true;
      topT.wrapS = THREE.ClampToEdgeWrapping; topT.wrapT = THREE.ClampToEdgeWrapping; topT.repeat.set(1, 1);
      const mSide = new THREE.MeshLambertMaterial({ map: sideT, color: 0xffffff, side: THREE.DoubleSide });
      const mTop = new THREE.MeshLambertMaterial({ map: topT, color: 0xffffff, side: THREE.DoubleSide });
      material = [mSide, mSide, mTop, mSide, mSide, mSide];
    } else if (pred.class === "fusuma") {
      const t = fusumaTex.clone(); t.needsUpdate = true;
      t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.repeat.set(1, 1);
      material = new THREE.MeshLambertMaterial({ map: t, color: 0xffffff, side: THREE.DoubleSide });
    } else if (pred.class === "door") {
      const sideT = doorTex.clone(); sideT.needsUpdate = true;
      sideT.wrapS = THREE.ClampToEdgeWrapping; sideT.wrapT = THREE.ClampToEdgeWrapping; sideT.repeat.set(1, 1);
      const topT = closetTopTex.clone(); topT.needsUpdate = true;
      topT.wrapS = THREE.ClampToEdgeWrapping; topT.wrapT = THREE.ClampToEdgeWrapping; topT.repeat.set(1, 1);
      const mSide = new THREE.MeshLambertMaterial({ map: sideT, color: 0xffffff, side: THREE.DoubleSide });
      const mTop = new THREE.MeshLambertMaterial({ map: topT, color: 0xffffff, side: THREE.DoubleSide });
      material = [mSide, mSide, mTop, mSide, mSide, mSide];
    } else if (pred.class === "glass door") {
      const t = glassDoorTex.clone(); t.needsUpdate = true;
      t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.repeat.set(1, 1);
      material = new THREE.MeshLambertMaterial({ map: t, color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide });
    } else {
      material = new THREE.MeshLambertMaterial({ color: classColors[pred.class] || 0xffffff });
    }
    const mesh = new THREE.Mesh(geometry, material);
    if (["wall", "door", "window", "closet", "fusuma", "glass door"].includes(pred.class)) {
      mesh.userData.isObstacle = true;
    }
    mesh.position.x = (pred.x - imageWidth / 2) * scale;
    mesh.position.y = 1.2;
    mesh.position.z = -(pred.y - imageHeight / 2) * scale;
    scene.add(mesh);
  });

  draggableObjects = [];
  selectedObject = null;
  rotationGizmo = null;
  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  dragOffset = new THREE.Vector3();
  dragIntersectPoint = new THREE.Vector3();
  threeContainerRect = container.getBoundingClientRect();
  isDragging = false;
  isRotating = false;

  const dom = renderer.domElement;
  dom.addEventListener('dblclick', onDoubleClick);
  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('pointercancel', onPointerUp);

  (function animate() {
    requestAnimationFrame(animate);
    if (controls) controls.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
  })();
}
