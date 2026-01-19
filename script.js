import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * 統合完全版 script.js
 * - 3モデル合成Roboflow解析 (高精度版)
 * - 家具ライブラリ連携 & ドラッグ移動
 * - Google Drive 連携
 */

let accessToken = null;
let latestJson = null;

// --- 家具配置用のグローバル変数 ---
const FURN_STORAGE_KEY = 'madomake_furniturePresets';
const GLB_PATHS = {
  desk: '机.glb',
  sofa: 'ソファ.glb'
};

const gltfLoader = new GLTFLoader();

// Three.js 共有変数
let scene = null;
let camera = null;
let renderer = null;
let controls = null;

// ドラッグ / 選択用変数
let raycaster = new THREE.Raycaster();
let pointer = new THREE.Vector2();
let dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let dragOffset = new THREE.Vector3();
let dragIntersectPoint = new THREE.Vector3();
let draggableObjects = [];
let selectedObject = null;
let isDragging = false;
let threeContainerRect = null;

// UI参照
let placeStatusEl = null;
let libraryListEl = null;
let fileSelectEl = null;

// Roboflow API 設定
const API = {
  outer: "https://detect.roboflow.com/floor-plan-japan-base-6xuaz/2?api_key=E0aoexJvBDgvE3nb1jkc",
  inner: "https://detect.roboflow.com/floor-plan-japan/7?api_key=E0aoexJvBDgvE3nb1jkc",
  extra: "https://detect.roboflow.com/floor-plan-japan-2-menv0/1?api_key=E0aoexJvBDgvE3nb1jkc&confidence=0.25"
};

// 色設定と除外リスト
const classColors = {
  wall: 0x999999, room: 0xffffff, kitchen: 0xf5f5dc, bathroom: 0xadd8e6,
  toilet: 0xffefd5, entrance: 0xd2b48c, balcony: 0xe0e0e0, door: 0x8b4513,
  "glass door": 0x87cefa, window: 0x1e90ff, closet: 0xffa500, fusuma: 0xda70d6,
  base: 0xeeeeee, outer: 0xeeeeee
};
const ignoreList = ['left side', 'right side', 'under side', 'top side'];

/* ========== 1. Google Drive 認証 ========== */
function handleCredentialResponse(_) {
  requestAccessToken();
}
window.handleCredentialResponse = handleCredentialResponse;

function requestAccessToken() {
  google.accounts.oauth2.initTokenClient({
    client_id: '479474446026-kej6f40kvfm6dsuvfeo5d4fm87c6god4.apps.googleusercontent.com',
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: (tokenResponse) => {
      accessToken = tokenResponse.access_token;
      updateFileSelect();
    }
  }).requestAccessToken();
}

/* ========== 2. Roboflow 解析 (3モデル合成ロジック) ========== */
async function runRoboflow(url, file) {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(url, { method: "POST", body: formData });
  return await res.json();
}

function calcIoU(a, b) {
  const ax1 = a.x - a.width / 2, ay1 = a.y - a.height / 2, ax2 = a.x + a.width / 2, ay2 = a.y + a.height / 2;
  const bx1 = b.x - b.width / 2, by1 = b.y - b.height / 2, bx2 = b.x + b.width / 2, by2 = b.y + b.height / 2;
  const iX1 = Math.max(ax1, bx1), iY1 = Math.max(ay1, by1), iX2 = Math.min(ax2, bx2), iY2 = Math.min(ay2, by2);
  if (iX2 < iX1 || iY2 < iY1) return 0;
  const iArea = (iX2 - iX1) * (iY2 - iY1);
  return iArea / (a.width * a.height + b.width * b.height - iArea);
}

async function runAllModels(file) {
  const [outer, inner, extra] = await Promise.all([
    runRoboflow(API.outer, file),
    runRoboflow(API.inner, file),
    runRoboflow(API.extra, file)
  ]);
  
  let finalPreds = [...(outer.predictions || []), ...(inner.predictions || [])];
  const extras = (extra.predictions || []).filter(ex => !finalPreds.some(f => calcIoU(ex, f) > 0.3));
  return { image: outer.image, predictions: [...finalPreds, ...extras] };
}

/* ========== 3. 3D描画 & カメラ移動 (805行版ロジック) ========== */
function initSceneWithFloorplan(predictions, imageWidth, imageHeight) {
  const container = document.getElementById('three-container');
  if (renderer) { renderer.dispose(); container.innerHTML = ''; }
  
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf6f7fb);
  camera = new THREE.PerspectiveCamera(75, container.clientWidth/container.clientHeight, 0.1, 1000);
  camera.position.set(5, 5, 5);
  controls = new OrbitControls(camera, renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(5, 10, 7); scene.add(sun);

  const scale = 0.05;
  const wallsGroup = new THREE.Group();

  predictions.forEach(p => {
    if (ignoreList.includes(p.class)) return;
    const isFloor = p.class === "base" || p.class === "outer";
    const h = isFloor ? 0.01 : 2.4;
    const geo = new THREE.BoxGeometry(p.width * scale, h * scale, p.height * scale);
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: classColors[p.class] || 0xffffff }));
    mesh.position.set((p.x - imageWidth/2) * scale, (h * scale)/2, -(p.y - imageHeight/2) * scale);
    isFloor ? scene.add(mesh) : wallsGroup.add(mesh);
  });
  scene.add(wallsGroup);

  // カメラのオートフィット
  const box = new THREE.Box3().setFromObject(wallsGroup.children.length ? wallsGroup : scene);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.z);
  camera.position.set(center.x, maxDim * 1.5, center.z + maxDim);
  controls.target.copy(center);

  // ドラッグ操作イベント
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('dblclick', e => selectObject(pickObject(e)));
}

/* ========== 4. 家具配置 (script.js ロジック継承) ========== */
function renderFurnitureLibrary() {
  if (!libraryListEl) return;
  const raw = localStorage.getItem(FURN_STORAGE_KEY);
  const items = raw ? (JSON.parse(raw).items || []) : [];
  libraryListEl.innerHTML = items.length ? '' : '<p class="hint">家具がありません</p>';
  items.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'libItemBtn'; btn.textContent = item.name;
    btn.onclick = () => spawnFurniture(item);
    libraryListEl.appendChild(btn);
  });
}

async function spawnFurniture(preset) {
  if (!scene) return alert('先に分析してください');
  const gltf = await gltfLoader.loadAsync(GLB_PATHS[preset.baseId || 'desk']);
  const model = gltf.scene;
  const curSize = new THREE.Vector3();
  new THREE.Box3().setFromObject(model).getSize(curSize);
  if (preset.size) model.scale.set(preset.size.x/curSize.x, preset.size.y/curSize.y, preset.size.z/curSize.z);
  model.traverse(o => { if (o.isMesh && preset.color) { o.material = o.material.clone(); o.material.color.set(preset.color); } });
  model.userData.draggable = true; model.userData.label = preset.name;
  scene.add(model); draggableObjects.push(model); selectObject(model);
}

function pickObject(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((event.clientX-rect.left)/rect.width)*2-1, -((event.clientY-rect.top)/rect.height)*2+1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(draggableObjects, true);
  if (hits.length > 0) {
    let obj = hits[0].object; while(obj.parent && obj.parent !== scene) obj = obj.parent;
    return obj;
  }
  return null;
}

function onPointerDown(e) {
  const obj = pickObject(e);
  if (obj && obj === selectedObject) {
    isDragging = true; controls.enabled = false;
    dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0,1,0), obj.position);
    dragOffset.subVectors(obj.position, raycaster.ray.intersectPlane(dragPlane, dragIntersectPoint));
  }
}

function onPointerMove(e) {
  if (!isDragging || !selectedObject) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX-rect.left)/rect.width)*2-1, -((event.clientY-rect.top)/rect.height)*2+1);
  raycaster.setFromCamera(pointer, camera);
  if (raycaster.ray.intersectPlane(dragPlane, dragIntersectPoint)) {
    selectedObject.position.x = dragIntersectPoint.x + dragOffset.x;
    selectedObject.position.z = dragIntersectPoint.z + dragOffset.z;
  }
}

function onPointerUp() { isDragging = false; controls.enabled = true; }
function selectObject(obj) {
  selectedObject = obj;
  placeStatusEl.textContent = obj ? `選択中：${obj.userData.label}` : '未選択';
}

/* ========== 5. Google Drive 連携 & 初期化 ========== */
async function updateFileSelect() {
  if (!accessToken) return;
  const res = await fetch("https://www.googleapis.com/drive/v3/files?q=mimeType='application/json'", { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  fileSelectEl.innerHTML = '<option value="">読み込むファイルを選択</option>';
  (data.files || []).forEach(f => {
    const opt = document.createElement('option'); opt.value = f.id; opt.textContent = f.name;
    fileSelectEl.appendChild(opt);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  placeStatusEl = document.getElementById('placeStatus');
  libraryListEl = document.getElementById('libraryList');
  fileSelectEl = document.getElementById('fileSelect');
  
  document.getElementById("analyzeBtn").onclick = async () => {
    const file = document.getElementById("imageInput").files[0];
    if (!file) return alert("画像を選んでください");
    const result = await runAllModels(file);
    latestJson = result;
    initSceneWithFloorplan(result.predictions, result.image.width, result.image.height);
  };

  document.getElementById("moveDeleteBtn").onclick = () => {
    if (selectedObject) { scene.remove(selectedObject); draggableObjects = draggableObjects.filter(o => o !== selectedObject); selectObject(null); }
  };
  document.getElementById("moveDoneBtn").onclick = () => selectObject(null);

  renderFurnitureLibrary();
});