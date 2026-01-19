import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * 完全統合版 script.js
 * 1. 3モデル合成Roboflow解析
 * 2. 家具ライブラリ配置 & ドラッグ移動
 * 3. Google Drive 連携
 */

let accessToken = null;
let latestJson = null;

// --- 家具配置用の設定 ---
const FURN_STORAGE_KEY = 'madomake_furniturePresets';
const GLB_PATHS = {
  desk: '机.glb',
  sofa: 'ソファ.glb'
};
const gltfLoader = new GLTFLoader();

// Roboflow API設定
const API = {
  outer: "https://detect.roboflow.com/floor-plan-japan-base-6xuaz/2?api_key=E0aoexJvBDgvE3nb1jkc",
  inner: "https://detect.roboflow.com/floor-plan-japan/7?api_key=E0aoexJvBDgvE3nb1jkc",
  extra: "https://detect.roboflow.com/floor-plan-japan-2-menv0/1?api_key=E0aoexJvBDgvE3nb1jkc&confidence=0.25"
};

// Three.js グローバル
let scene, camera, renderer, controls;
let raycaster = new THREE.Raycaster();
let pointer = new THREE.Vector2();
let dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let dragOffset = new THREE.Vector3();
let dragIntersectPoint = new THREE.Vector3();
let draggableObjects = [];
let selectedObject = null;
let isDragging = false;
let threeContainerRect = null;

// UI要素
let placeStatusEl, libraryListEl, fileSelectEl;

/* ========== 1. Google Drive 認証 ========== */
function handleCredentialResponse(response) {
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

/* ========== 2. 家具ライブラリ & 配置ロジック ========== */
function getFurniturePresets() {
  const raw = localStorage.getItem(FURN_STORAGE_KEY);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return data.items || data;
  } catch (e) { return []; }
}

function renderFurnitureLibrary() {
  if (!libraryListEl) return;
  const presets = getFurniturePresets();
  libraryListEl.innerHTML = '';
  if (!presets.length) {
    libraryListEl.innerHTML = '<p style="font-size:12px; color:#666;">保存された家具がありません</p>';
    return;
  }
  presets.forEach((preset) => {
    const btn = document.createElement('button');
    btn.className = 'libItemBtn';
    btn.textContent = preset.name || '(名称未設定)';
    btn.onclick = () => spawnFurnitureFromPreset(preset);
    libraryListEl.appendChild(btn);
  });
}

async function spawnFurnitureFromPreset(preset) {
  if (!scene) return alert('先に間取りを分析してください。');
  const url = GLB_PATHS[preset.baseId || 'desk'];
  try {
    const gltf = await gltfLoader.loadAsync(url);
    const model = gltf.scene;

    // 家具生成側の設定（サイズ・色）を適用
    const bbox = new THREE.Box3().setFromObject(model);
    const curSize = new THREE.Vector3();
    bbox.getSize(curSize);
    if (preset.size) {
      model.scale.set(preset.size.x / curSize.x, preset.size.y / curSize.y, preset.size.z / curSize.z);
    }
    model.traverse(o => {
      if (o.isMesh && preset.color) {
        o.material = o.material.clone();
        o.material.color.set(preset.color);
      }
    });

    model.userData.draggable = true;
    model.userData.label = preset.name;
    model.position.set(0, 0.01, 0); // 床の少し上に配置
    scene.add(model);
    draggableObjects.push(model);
    selectObject(model);
  } catch (e) { alert('モデル読み込みエラー'); }
}

function selectObject(obj) {
  selectedObject = obj;
  if (placeStatusEl) placeStatusEl.textContent = obj ? `選択中：${obj.userData.label}` : '未選択';
}

/* ========== 3. Roboflow 3モデル合成ロジック ========== */
async function runRoboflow(url, file) {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(url, { method: "POST", body: formData });
  return await res.json();
}

function calcIoU(a, b) {
  const ax1 = a.x - a.width/2, ay1 = a.y - a.height/2, ax2 = a.x + a.width/2, ay2 = a.y + a.height/2;
  const bx1 = b.x - b.width/2, by1 = b.y - b.height/2, bx2 = b.x + b.width/2, by2 = b.y + b.height/2;
  const interX1 = Math.max(ax1, bx1), interY1 = Math.max(ay1, by1);
  const interX2 = Math.min(ax2, bx2), interY2 = Math.min(ay2, by2);
  if (interX2 < interX1 || interY2 < interY1) return 0;
  const interArea = (interX2 - interX1) * (interY2 - interY1);
  const areaA = a.width * a.height, areaB = b.width * b.height;
  return interArea / (areaA + areaB - interArea);
}

async function runAllModels(file) {
  const [outer, inner, extra] = await Promise.all([
    runRoboflow(API.outer, file),
    runRoboflow(API.inner, file),
    runRoboflow(API.extra, file)
  ]);

  let finalPreds = [...(outer.predictions || []), ...(inner.predictions || [])];
  const extras = (extra.predictions || []).filter(ex => 
    !finalPreds.some(f => calcIoU(ex, f) > 0.3)
  );
  return { image: outer.image, predictions: [...finalPreds, ...extras] };
}

/* ========== 4. 3D描画 & 操作メイン ========== */
function initSceneWithFloorplan(predictions, imageWidth, imageHeight) {
  const container = document.getElementById('three-container');
  if (renderer) { renderer.dispose(); container.innerHTML = ''; }
  
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f5f5);
  camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
  camera.position.set(5, 5, 5);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0x404040));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1);
  dirLight.position.set(5, 10, 7);
  scene.add(dirLight);

  const scale = 0.1;
  // 間取り描画（壁・床）
  predictions.forEach(pred => {
    const isFloor = pred.class === "base" || pred.class === "outer";
    const geometry = isFloor ? 
      new THREE.PlaneGeometry(pred.width * scale, pred.height * scale) :
      new THREE.BoxGeometry(pred.width * scale, 2.4, pred.height * scale);
    
    const material = new THREE.MeshLambertMaterial({ color: isFloor ? 0xeeeeee : 0x999999 });
    const mesh = new THREE.Mesh(geometry, material);
    
    mesh.position.set((pred.x - imageWidth/2) * scale, isFloor ? 0 : 1.2, -(pred.y - imageHeight/2) * scale);
    if (isFloor) mesh.rotation.x = -Math.PI / 2;
    scene.add(mesh);
  });

  // ドラッグ操作イベント登録
  threeContainerRect = container.getBoundingClientRect();
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('dblclick', (e) => {
    selectObject(pickObject(e));
  });

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
}

// レイキャスト関数
function pickObject(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(draggableObjects, true);
  if (hits.length > 0) {
    let obj = hits[0].object;
    while (obj.parent && obj.parent !== scene) obj = obj.parent;
    return obj;
  }
  return null;
}

function onPointerDown(event) {
  const obj = pickObject(event);
  if (obj && obj === selectedObject) {
    isDragging = true;
    controls.enabled = false;
    dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), obj.position);
    dragOffset.subVectors(obj.position, raycaster.ray.intersectPlane(dragPlane, dragIntersectPoint));
  }
}

function onPointerMove(event) {
  if (!isDragging || !selectedObject) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  if (raycaster.ray.intersectPlane(dragPlane, dragIntersectPoint)) {
    selectedObject.position.x = dragIntersectPoint.x + dragOffset.x;
    selectedObject.position.z = dragIntersectPoint.z + dragOffset.z;
  }
}

function onPointerUp() {
  isDragging = false;
  controls.enabled = true;
}

/* ========== 5. 初期化 & イベント連携 ========== */
document.addEventListener("DOMContentLoaded", () => {
  libraryListEl = document.getElementById('libraryList');
  placeStatusEl = document.getElementById('placeStatus');
  fileSelectEl = document.getElementById('fileSelect');
  const analyzeBtn = document.getElementById("analyzeBtn");
  const imageInput = document.getElementById("imageInput");
  const moveDoneBtn = document.getElementById("moveDoneBtn");
  const moveDeleteBtn = document.getElementById("moveDeleteBtn");

  analyzeBtn.addEventListener("click", async () => {
    const file = imageInput.files[0];
    if (!file) return alert("画像を選んでください");
    analyzeBtn.disabled = true;
    const result = await runAllModels(file);
    initSceneWithFloorplan(result.predictions, result.image.width, result.image.height);
    analyzeBtn.disabled = false;
  });

  moveDoneBtn.onclick = () => selectObject(null);
  moveDeleteBtn.onclick = () => {
    if (selectedObject) {
      scene.remove(selectedObject);
      draggableObjects = draggableObjects.filter(o => o !== selectedObject);
      selectObject(null);
    }
  };

  renderFurnitureLibrary();
  window.addEventListener('storage', (e) => {
    if (e.key === FURN_STORAGE_KEY) renderFurnitureLibrary();
  });
});

/* Google Drive 操作用関数 (updateFileSelect, deleteBtn等は既存のものを継承) */
async function updateFileSelect() {
  if (!accessToken) return;
  const res = await fetch("https://www.googleapis.com/drive/v3/files?q=mimeType='application/json'", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json();
  fileSelectEl.innerHTML = '<option value="">読み込むファイルを選択</option>';
  data.files.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.id; opt.textContent = f.name;
    fileSelectEl.appendChild(opt);
  });
}