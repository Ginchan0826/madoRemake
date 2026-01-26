console.log("GLTFLoader =", THREE.GLTFLoader);
console.log("THREE", THREE);
console.log("OrbitControls", OrbitControls);
console.log("draw3D", typeof draw3D);


//let accessToken = null;
if (typeof window.accessTok === "undefined") {
  window.accessTok = null;
}

//let latestJson = null;
if (typeof window.latestJson === "undefined") {
  window.latestJson = null;
}


/* Googleログイン */
function handleCredentialResponse(response) {
  requestwindow.accessTok();
}
window.handleCredentialResponse = handleCredentialResponse;

function requestAccessToken() {
  google.accounts.oauth2.initTokenClient({
    client_id: '479474446026-kej6f40kvfm6dsuvfeo5d4fm87c6god4.apps.googleusercontent.com',
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: (tokenResponse) => {
      window.accessToke = tokenResponse.access_token;
      updateFileSelect();
    }
  }).requestwindow.accessTok();
}

document.addEventListener("DOMContentLoaded", () => {
  const uploadHeader = document.getElementById("upload-header");
  const uploadContainer = document.getElementById("upload-container");
  const resultHeader = document.getElementById("result-header");
  const resultContainer = document.getElementById("result-container");
  const analyzeBtn = document.getElementById("analyzeBtn");
  const previewImg = document.getElementById("preview");
  const resultPre = document.getElementById("result");

  const filenameInput = document.getElementById("filenameInput");
  const fileSelect = document.getElementById("fileSelect");

  let selectedFile = null;

  /* モデルURLまとめ */
  const API = {
    outer: "https://detect.roboflow.com/floor-plan-japan-base-6xuaz/2?api_key=E0aoexJvBDgvE3nb1jkc",
    inner: "https://detect.roboflow.com/floor-plan-japan/7?api_key=E0aoexJvBDgvE3nb1jkc",
    extra: "https://detect.roboflow.com/floor-plan-japan-2-menv0/1?api_key=E0aoexJvBDgvE3nb1jkc&confidence=0.25"
  };

  /* 共通 Roboflow 呼び出し関数 */
  async function runRoboflow(url, file) {
    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(url, { method: "POST", body: formData });
    return await res.json();
  }

  /* IoU 計算 */
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

  /* 壁補完（Wall ↔ Fusuma のみ） */
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

  /* 重なり優先ルール */
  function applyPriority(preds) {
    const result = [];
    const items = preds.slice();

    items.forEach(p => {
      let skip = false;

      for (let k = 0; k < items.length; k++) {
        const other = items[k];
        if (p === other) continue;

        if (calcIoU(p, other) < 0.15) continue;

        if ((p.class === "closet" || p.class === "door") && other.class === "wall") {
          skip = true;
          break;
        }

        if (p.class === "wall" && (other.class === "window" || other.class === "glass door")) {
          skip = true;
          break;
        }

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

  /* 折りたたみUI */
  function openContainer(c) {
    c.classList.remove("collapsed");
    c.classList.add("expanded");
  }
  function closeContainer(c) {
    c.classList.remove("expanded");
    c.classList.add("collapsed");
  }
  function toggleExclusive(openElem, closeElem) {
    if (openElem.classList.contains("expanded")) {
      closeContainer(openElem);
    } else {
      openContainer(openElem);
      closeContainer(closeElem);
    }
  }

  uploadHeader.addEventListener("click", () => {
    toggleExclusive(uploadContainer, resultContainer);
  });

  resultHeader.addEventListener("click", () => {
    toggleExclusive(resultContainer, uploadContainer);
  });

  /* 画像プレビュー */
  document.getElementById("imageInput").addEventListener("change", (e) => {
    selectedFile = e.target.files[0];
    if (!selectedFile) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      previewImg.src = ev.target.result;
      openContainer(uploadContainer);
      closeContainer(resultContainer);
    };
    reader.readAsDataURL(selectedFile);
  });

  /* ローディング表示 */
  const loadingText = document.createElement("div");
  loadingText.style.color = "#008cff";
  loadingText.style.fontWeight = "bold";
  document.querySelector(".left-pane").appendChild(loadingText);

  let loadingInterval;
  /* ★ 3モデル合成処理（IoU完全実装＋base除外＋壁補完＋優先ルール） */
  async function runAllModels(file) {
    const outer = await runRoboflow(API.outer, file);
    const inner = await runRoboflow(API.inner, file);
    const extra = await runRoboflow(API.extra, file);

    const outerBase = outer?.predictions?.find(p => p.class === "base") || null;

    if (!outerBase) {
      return {
        image: inner.image || outer.image || extra.image || { width: 100, height: 100 },
        predictions: (inner.predictions || []).filter(p => p.class !== "base" && p.class !== "outer")
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

    const filteredInner = (inner.predictions || []).filter(
      p => isInside(p) && p.class !== "base" && p.class !== "outer"
    );
    const filteredExtra = (extra.predictions || []).filter(
      p => isInside(p) && p.class !== "base" && p.class !== "outer"
    );

    let finalPreds = [outerBox, ...filteredInner];

    filteredExtra.forEach(e => {
      let duplicate = false;
      for (const ii of filteredInner) {
        if (e.class === ii.class && calcIoU(e, ii) > 0.4) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) finalPreds.push(e);
    });

    finalPreds.push(...fillWallGaps(finalPreds, 40));
    finalPreds = applyPriority(finalPreds);

    return {
      image: outer.image,
      predictions: finalPreds
    };
  }

  /* ★ メイン解析ボタン */
  analyzeBtn.addEventListener("click", async () => {
    if (!selectedFile) {
      alert("画像を選択してください");
      return;
    }

    analyzeBtn.disabled = true;
    loadingText.textContent = "分析中";
    let dot = 0;

    loadingInterval = setInterval(() => {
      dot = (dot + 1) % 4;
      loadingText.textContent = "分析中" + ".".repeat(dot);
    }, 500);

    const mode = document.getElementById("modelSelector")?.value || "all";

    try {
      let result;
      if (mode === "outer") result = await runRoboflow(API.outer, selectedFile);
      else if (mode === "inner") result = await runRoboflow(API.inner, selectedFile);
      else if (mode === "extra") result = await runRoboflow(API.extra, selectedFile);
      else result = await runAllModels(selectedFile);

      window.latestJson
 = result;
      resultPre.textContent = JSON.stringify(result, null, 2);

      openContainer(resultContainer);
      closeContainer(uploadContainer);

      draw3D(
        result.predictions,
        result.image?.width || 100,
        result.image?.height || 100
      );
    } catch (e) {
      console.error(e);
      alert("解析エラー");
    } finally {
      clearInterval(loadingInterval);
      loadingText.textContent = "";
      analyzeBtn.disabled = false;
    }
  });

  /* Google Drive 保存 */
  document.getElementById("saveBtn").addEventListener("click", () => {
    if (!window.accessToke || !window.latestJson

    ) return alert("ログインまたは解析が必要です");

    const filename = filenameInput.value.trim();
    if (!filename) return alert("保存名を入力してください");

    const metadata = { name: `${filename}.json`, mimeType: "application/json" };
    const file = new Blob([JSON.stringify(window.latestJson

    )], { type: "application/json" });

    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", file);

    fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: new Headers({ Authorization: "Bearer " + window.accessToke
       }),
      body: form
    })
      .then(() => {
        alert("保存完了");
        updateFileSelect();
      })
      .catch(() => alert("保存失敗"));
  });

  /* Drive 読み込み */
  document.getElementById("loadBtn").addEventListener("click", () => {
    const fileId = fileSelect.value;
    if (!window.accessToke || !fileId) return alert("ログインまたはファイルを選択してください");

    fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: new Headers({ Authorization: "Bearer " + window.accessToke
       })
    })
      .then(res => res.json())
      .then(data => {
        window.latestJson
 = data;
        resultPre.textContent = JSON.stringify(data, null, 2);
        draw3D(data.predictions, data.image.width, data.image.height);
      })
      .catch(() => alert("読み込み失敗"));
  });

  /* Drive 削除 */
  document.getElementById("deleteBtn").addEventListener("click", () => {
    const fileId = fileSelect.value;
    if (!window.accessToke || !fileId) return;

    if (!confirm("本当に削除しますか？")) return;

    fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: "DELETE",
      headers: new Headers({ Authorization: "Bearer " + window.accessToke
       })
    }).then(() => updateFileSelect());
  });


}); // DOMContentLoaded end

  /* =========================================================
     3D描画（床を base から生成、オブジェクト高さ/厚み調整）
     ========================================================= */
  function draw3D(predictions, imageWidth, imageHeight) {
    predictions = predictions || [];

    /* scene */
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);

    /* camera */
    const camera = new THREE.PerspectiveCamera(
      75,
      containerAspect(),
      0.1,
      1000
    );
    camera.position.set(5, 5, 5);

    /* renderer */
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    const container = document.getElementById("three-container");
    container.innerHTML = "";
    renderer.setSize(container.clientWidth, container.clientHeight || 600);
    renderer.setClearColor(0xffffff, 1);
    container.appendChild(renderer.domElement);

    /* controls */
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2;

    /* scale */
    const scale = 0.01;

    /* colors */
    const colors = {
      wall: 0x999999,
      door: 0x8b4513,
      "glass door": 0x87cefa,
      window: 0x1e90ff,
      closet: 0xffa500,
      fusuma: 0xda70d6
    };

    /* ignore list */
    const ignore = [
      "left side",
      "right side",
      "under side",
      "top side",
      "base",
      "outer"
    ];

    /* ===== 床生成（base優先） ===== */
    const baseObj = predictions.find(p => p.class === "base");

    if (baseObj) {
      const floorGeo = new THREE.PlaneGeometry(
        baseObj.width * scale,
        baseObj.height * scale
      );
      const floorMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const floor = new THREE.Mesh(floorGeo, floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.x = (baseObj.x - imageWidth / 2) * scale;
      floor.position.z = -(baseObj.y - imageHeight / 2) * scale;
      floor.position.y = 0;
      scene.add(floor);
    } else {
      const floorGeo = new THREE.PlaneGeometry(
        imageWidth * scale,
        imageHeight * scale
      );
      const floorMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const floor = new THREE.Mesh(floorGeo, floorMat);
      floor.rotation.x = -Math.PI / 2;
      scene.add(floor);
    }

    /* base除外 */
    let drawPreds = predictions.filter(
      p => p.class !== "base" && p.class !== "outer"
    );

    /* 高さ・厚み調整 */
    drawPreds.forEach(pred => {
      if (ignore.includes(pred.class)) return;

      let thicknessY = 0.5;
      let extraZ = 0;

      if (pred.class === "closet" || pred.class === "door") {
        thicknessY = 0.35;
      }

      if (pred.class === "window" || pred.class === "glass door") {
        thicknessY = 0.6;
        extraZ = 0.02 / scale;
      }

      pred._thicknessY = thicknessY;
      pred._extraZ = extraZ;
    });

    drawPreds = applyPriority(drawPreds);

    /* メッシュ生成 */
    drawPreds.forEach(pred => {
      if (ignore.includes(pred.class)) return;

      const thicknessY = pred._thicknessY ?? 0.5;
      const extraZ = pred._extraZ ?? 0;

      const width = pred.width * scale;
      const depth = pred.height * scale + extraZ * scale;

      const geo = new THREE.BoxGeometry(width, thicknessY, depth);
      const mat = new THREE.MeshLambertMaterial({
        color: colors[pred.class] || 0xffffff
      });
      const mesh = new THREE.Mesh(geo, mat);

      mesh.position.x = (pred.x - imageWidth / 2) * scale;
      mesh.position.y = thicknessY / 2;
      mesh.position.z = -(pred.y - imageHeight / 2) * scale;

      scene.add(mesh);
    });

    /* lighting */
    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);
    scene.add(new THREE.AmbientLight(0x404040));

    /* animate */
    function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    function containerAspect() {
    　const container = document.getElementById("three-container");
      const w = container.clientWidth || 800;
      const h = container.clientHeight || 600;
      return w / h;
    }
  }


/* =========================================================
   家具配置・ドラッグ操作（scriptMadori.js 統合部）
   ========================================================= */

let furnitureList = [];
let selectedFurniture = null;
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();

/* loader */
//const gltfLoader = new THREE.GLTFLoader();

/* furniture data */
const furnitureData = [
  { name: "bed", path: "models/bed.glb", scale: 0.01 },
  { name: "desk", path: "models/desk.glb", scale: 0.01 },
  { name: "chair", path: "models/chair.glb", scale: 0.01 },
  { name: "sofa", path: "models/sofa.glb", scale: 0.01 }
];

/* UI生成 */
function createFurnitureButtons() {
  const container = document.getElementById("furniture-buttons");
  if (!container) return;

  container.innerHTML = "";

  furnitureData.forEach(item => {
    const btn = document.createElement("button");
    btn.textContent = item.name;
    btn.addEventListener("click", () => loadFurniture(item));
    container.appendChild(btn);
  });
}

/* load furniture */
function loadFurniture(item) {
    const gltfLoader = new THREE.GLTFLoader();
    
  gltfLoader.load(item.path, gltf => {
    const model = gltf.scene;
    model.scale.set(item.scale, item.scale, item.scale);
    model.position.set(0, 0, 0);

    model.traverse(obj => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });

    furnitureList.push(model);
    currentScene.add(model);
  });
}

/* mouse events */
function onMouseDown(event) {
  updateMouse(event);
  raycaster.setFromCamera(mouse, currentCamera);

  const intersects = raycaster.intersectObjects(furnitureList, true);
  if (intersects.length > 0) {
    selectedFurniture = intersects[0].object.parent;
  }
}

function onMouseMove(event) {
  if (!selectedFurniture) return;

  updateMouse(event);
  raycaster.setFromCamera(mouse, currentCamera);

  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const intersectPoint = new THREE.Vector3();
  raycaster.ray.intersectPlane(plane, intersectPoint);

  if (intersectPoint) {
    selectedFurniture.position.x = intersectPoint.x;
    selectedFurniture.position.z = intersectPoint.z;
  }
}

function onMouseUp() {
  selectedFurniture = null;
}

function updateMouse(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

/* events bind */
function bindFurnitureEvents() {
  renderer.domElement.addEventListener("mousedown", onMouseDown);
  renderer.domElement.addEventListener("mousemove", onMouseMove);
  renderer.domElement.addEventListener("mouseup", onMouseUp);
}

/* ===== scene references ===== */
let currentScene = null;
let currentCamera = null;
let renderer = null;

/* scene受け取り */
function registerThreeContext(scene, camera, rendererInstance) {
  currentScene = scene;
  currentCamera = camera;
  renderer = rendererInstance;

  bindFurnitureEvents();
  createFurnitureButtons();
}

/* =========================================================
   draw3D 拡張（家具連携）
   ========================================================= */

const _originalDraw3D = draw3D;
draw3D = function(predictions, w, h) {
  _originalDraw3D(predictions, w, h);

  /* scene / camera / renderer を取得 */
  const container = document.getElementById("three-container");
  const canvas = container.querySelector("canvas");
  if (!canvas) return;

  const scene = canvas.__threeObj?.scene || null;
  const camera = canvas.__threeObj?.camera || null;
  const rendererInstance = canvas.__threeObj?.renderer || null;

  if (scene && camera && rendererInstance) {
    registerThreeContext(scene, camera, rendererInstance);
  }
};
