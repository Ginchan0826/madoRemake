import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let accessToken = null;
let latestJson = null;

// Roboflow settings
const ROBOFLOW_MODEL = 'floor-plan-japan';
const ROBOFLOW_VERSION = 7;
const ROBOFLOW_API_KEY = 'E0aoexJvBDgvE3nb1jkc';

// Furniture presets (shared with 家具生成タブ)
const FURN_STORAGE_KEY = 'madomake_furniturePresets';

// GLB model paths (relative to 間取り図/indexMadori.html)
const GLB_PATHS = {
  desk: '机.glb',
  sofa: 'ソファ.glb'
};

const gltfLoader = new GLTFLoader();

// Three.js globals
let scene = null;
let camera = null;
let renderer = null;
let controls = null;

// Drag / select globals
let raycaster = null;
let pointer = null;
let dragPlane = null;
let dragOffset = null;
let dragIntersectPoint = null;
let draggableObjects = [];
let selectedObject = null;
let isDragging = false;
let threeContainerRect = null;

// UI refs
let placeStatusEl = null;
let moveDoneBtn = null;
let moveDeleteBtn = null;
let boxWEl = null;
let boxHEl = null;
let boxDEl = null;
let fileSelectEl = null;
let libraryListEl = null;

// Unit scale for boxes (1 = 1m 相当)
const UNIT_SCALE = 1.0;

/* ========== Google Drive 認証 ========== */
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

/* ========== localStorage: 家具プリセット取得 ========== */
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


/* プリセットの外寸を「m」に統一して返す
   - 中間案: UI表示/保存は cm, Three.js シーンは m
   - 旧データ（m保存）も残っている可能性があるので、unit が無い場合は値から推定して吸収する */
function presetSizeToMeters(preset) {
  const size = (preset && preset.size) ? preset.size : {};
  const rx = Number(size.x);
  const ry = Number(size.y);
  const rz = Number(size.z);

  const unitRaw =
    (preset && (preset.sizeUnit || preset.unit || preset.units || preset.lengthUnit)) || '';
  const unit = String(unitRaw).toLowerCase().trim();

  // まず unit 指定があればそれを優先
  let factor = 1; // 乗算して m にする係数
  if (unit === 'cm') factor = 0.01;
  else if (unit === 'm' || unit === 'meter' || unit === 'meters') factor = 1;
  else {
    // unit が無ければ値から推定（家具寸法で 10m 超は現実的にほぼ無いので cm 扱い）
    const candidates = [rx, ry, rz].filter((v) => Number.isFinite(v));
    const maxv = candidates.length ? Math.max(...candidates) : 1;
    factor = maxv > 10 ? 0.01 : 1;
  }

  const fallbackRaw = (factor === 0.01) ? 100 : 1; // 100cm=1m, 1m=1m
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
    alert('先に「Roboflowで分析」で3D表示を生成してください。');
    return;
  }

  const target = presetSizeToMeters(preset);

  const baseId = preset.baseId || 'generic';
  const name = preset.name || baseId;
  const modelPath = GLB_PATHS[baseId];
  const colorHex = colorFromPreset(preset);

  // 該当GLBがなければ箱で代用
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

    // 元のサイズを取得
    const bbox = new THREE.Box3().setFromObject(root);
    const curSize = new THREE.Vector3();
    bbox.getSize(curSize);
    curSize.x = curSize.x || 1;
    curSize.y = curSize.y || 1;
    curSize.z = curSize.z || 1;

    // 目標外寸に合わせてスケーリング
    const scaleVec = new THREE.Vector3(
      target.x / curSize.x,
      target.y / curSize.y,
      target.z / curSize.z
    );
    root.scale.copy(scaleVec);

    // スケール後に床・原点に合わせる
    const bbox2 = new THREE.Box3().setFromObject(root);
    const center2 = new THREE.Vector3();
    bbox2.getCenter(center2);

    root.position.set(-center2.x, -bbox2.min.y, -center2.z);

    // 色適用
    root.traverse((o) => {
      if (o.isMesh && o.material && 'color' in o.material) {
        o.material.color.setHex(colorHex);
        o.material.needsUpdate = true;
      }
    });

    // ドラッグ可能な家具としてマーク
    root.userData.draggable = true;
    root.userData.baseId = baseId;
    root.userData.label = name;

    scene.add(root);
    draggableObjects.push(root);
    selectObject(root);
  } catch (err) {
    console.error('[MADORI] GLB load failed', err);
    alert('家具モデルの読み込みに失敗しました（' + name + '）。パスやファイル名を確認してください。');
    // フォールバックとして箱を出す
    addBoxAtCenter(target.x, target.y, target.z, colorHex, { baseId, name });
  }
}

/* 手動で出す箱（物体生成ボタン用） */
function addBoxAtCenter(w, h, d, color = 0x2194ce, meta = {}) {
  if (!scene) {
    alert('先に「Roboflowで分析」で3D表示を生成してください。');
    return;
  }
  const geo = new THREE.BoxGeometry(w * UNIT_SCALE, h * UNIT_SCALE, d * UNIT_SCALE);
  const mat = new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);

  // 底面が床に乗るように
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

/* ========== Raycast / Drag ========== */
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

/* ========== Google Drive ファイル一覧更新 ========== */
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

/* ========== DOMContentLoaded ========== */
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

  // 折りたたみ
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

  // 分析中テキスト
  const loadingText = document.createElement('div');
  loadingText.style.color = '#008cff';
  loadingText.style.fontWeight = 'bold';
  loadingText.style.marginTop = '10px';
  document.querySelector('.left-pane').appendChild(loadingText);

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

    const formData = new FormData();
    formData.append('file', selectedFile);
    const url = `https://detect.roboflow.com/${ROBOFLOW_MODEL}/${ROBOFLOW_VERSION}?api_key=${ROBOFLOW_API_KEY}`;

    try {
      const res = await fetch(url, { method: 'POST', body: formData });
      const result = await res.json();

      clearInterval(loadingInterval);
      loadingText.textContent = '';
      latestJson = result;
      if (resultPre) {
        resultPre.textContent = JSON.stringify(result, null, 2);
      }
      openContainer(resultContainer);
      closeContainer(uploadContainer);

      initSceneWithFloorplan(result.predictions, result.image.width, result.image.height);
    } catch (err) {
      clearInterval(loadingInterval);
      loadingText.textContent = 'エラー: ' + err.message;
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
        initSceneWithFloorplan(data.predictions, data.image.width, data.image.height);
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

  // 物体生成
  if (genBoxBtn) {
    genBoxBtn.addEventListener('click', () => {
      const w = parseFloat(boxWEl.value || '1') || 1;
      const h = parseFloat(boxHEl.value || '1') || 1;
      const d = parseFloat(boxDEl.value || '1') || 1;
      addBoxAtCenter(w, h, d, 0x2194ce, { baseId: 'manual', name: '箱' });
    });
  }

  // 完了・削除
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

  // 家具ライブラリを初期描画＆storageイベントで更新
  renderFurnitureLibrary();
  window.addEventListener('storage', (e) => {
    if (e.key === FURN_STORAGE_KEY) {
      renderFurnitureLibrary();
    }
  });

  // Drive のファイル一覧
  updateFileSelect();
});

/* ========== 間取りの3Dシーン構築 ========== */
function initSceneWithFloorplan(predictions, imageWidth, imageHeight) {
  const container = document.getElementById('three-container');
  if (!container) {
    console.error('#three-container が見つかりません');
    return;
  }

  // 既存のcanvasを破棄
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

  // ★ コンテナサイズに合わせて renderer / camera を調整する関数
  function resizeRendererToContainer() {
    const width = container.clientWidth || 640;
    const height = container.clientHeight || 600;
    renderer.setSize(width, height, false);      // false で CSS サイズをいじらない
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    threeContainerRect = container.getBoundingClientRect();
  }

  // 初回＆リサイズ時に実行
  resizeRendererToContainer();
  const ro = new ResizeObserver(resizeRendererToContainer);
  ro.observe(container);
  window.addEventListener('resize', resizeRendererToContainer);

  camera.position.set(5, 5, 5);
  camera.lookAt(0, 0, 0);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.25;
  controls.maxPolarAngle = Math.PI / 2;

  const dir = new THREE.DirectionalLight(0xffffff, 1);
  dir.position.set(5, 10, 7);
  scene.add(dir);
  scene.add(new THREE.AmbientLight(0x404040));

  //const scale = 0.01; 間取りの大きさ
  const scale = 0.1;
  // グループ化（後で「壁だけ」でカメラを寄せるため）
  const floorGroup = new THREE.Group();
  const wallsGroup = new THREE.Group();
  scene.add(floorGroup);
  scene.add(wallsGroup);

  const floorGeometry = new THREE.PlaneGeometry(imageWidth * scale, imageHeight * scale);
  const floorMaterial = new THREE.MeshLambertMaterial({ color: 0xf0f0f0 });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.userData.isFloor = true;
  floorGroup.add(floor);

  // ===== スケール変更に追従して「見た目が平べったい」を防ぐ調整 =====
  const floorW = imageWidth * scale;
  const floorH = imageHeight * scale;
  const sceneSize = Math.max(floorW, floorH);

  // 初期値（後で「壁の範囲」に合わせて自動フレーミングする）
  camera.far = Math.max(1000, sceneSize * 10);
  camera.updateProjectionMatrix();
  camera.position.set(sceneSize * 0.6, sceneSize * 0.5, sceneSize * 0.6);
  camera.lookAt(0, 0, 0);

  if (controls) {
    controls.target.set(0, 0, 0);
    controls.maxDistance = sceneSize * 6;
    controls.update();
  }

  // ライトの初期位置（後でフレーミング結果に合わせて調整）
  dir.position.set(sceneSize * 0.25, sceneSize * 0.7, sceneSize * 0.35);
  dir.target.position.set(0, 0, 0);
  scene.add(dir.target);

  // ★ 指定オブジェクトにカメラを「寄せる」
  function frameCameraToObject(obj3d, padding = 1.05) {
    if (!obj3d || !camera) return;
    const box = new THREE.Box3().setFromObject(obj3d);
    if (box.isEmpty()) return;

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = THREE.MathUtils.degToRad(camera.fov);
    let distance = (maxDim / 2) / Math.tan(fov / 2);
    distance *= padding;

    // 少し斜め上から見る（見やすい角度）
    const dirVec = new THREE.Vector3(1, 0.75, 1).normalize();

    camera.near = Math.max(0.1, distance / 200);
    camera.far = Math.max(1000, distance * 200);
    camera.updateProjectionMatrix();

    camera.position.copy(center).addScaledVector(dirVec, distance);
    camera.lookAt(center);

    if (controls) {
      controls.target.copy(center);
      controls.minDistance = Math.max(0.1, distance * 0.12);
      controls.maxDistance = distance * 10;
      controls.update();
    }

    // ライトも中心へ寄せる
    dir.position.set(center.x + distance * 0.25, center.y + distance * 0.85, center.z + distance * 0.35);
    dir.target.position.copy(center);
  }

  const classColors = {
    wall: 0x999999,
    door: 0x8b4513,
    'glass door': 0x87cefa,
    window: 0x1e90ff,
    closet: 0xffa500,
    fusuma: 0xda70d6
  };
  const ignoreList = ['left side', 'right side', 'under side', 'top side'];

  (predictions || []).forEach((pred) => {
    if (ignoreList.includes(pred.class)) return;
    const geometry = new THREE.BoxGeometry(
      pred.width * scale,
      2.4,
      pred.height * scale
    );
    const color = classColors[pred.class] || 0xffffff;
    const material = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);

    mesh.position.x = (pred.x - imageWidth / 2) * scale;
    mesh.position.y = 2.4 / 2;
    mesh.position.z = -(pred.y - imageHeight / 2) * scale;

    wallsGroup.add(mesh);
  });

  // 分析後、最初の表示で「引きすぎ」にならないよう、壁の範囲でカメラを自動で寄せる
  // ※壁が1つも無い場合だけ床を基準にする
  if (wallsGroup.children.length) frameCameraToObject(wallsGroup, 1.05);
  else frameCameraToObject(floorGroup, 1.15);

  // ドラッグ周りのセットアップ
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
