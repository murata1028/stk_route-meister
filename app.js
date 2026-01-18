// app.js — 最終クリーン版（広島駅固定・バスウェイ強化）
// IMPORTANT: Set your ORS API key here:
const ORS_API_KEY =◯◯=";

// ===========================
// MAP 初期化
// ===========================
const map = L.map("map").setView([34.3963, 132.4753], 15);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19
}).addTo(map);

let currentRoute = null;
let busRouteLayers = {};
let dangerMarkers = [];
let userLocation = null;
let busRoutesDynamic = {};
let busStopsAll = [];

let limitedBusStopMarkers = [];
let currentZoomLevel = map.getZoom();

// ===========================
// 固定出発地／目的地データ
// ===========================
const hiroshimaStation = { lat: 34.39702, lng: 132.47534, name: "広島駅" }; 
const destinations = {
    hondori: { lat: 34.39397, lng: 132.45536 },
    peacePark: { lat: 34.39153, lng: 132.45360 },
    orizuruTower: { lat: , lng: 132.45494 }
};

// ===========================
// マップイベントリスナー
// ===========================

// 現在地取得（map.locate）- マーカー表示のみ
map.on("locationfound", (e) => {
    userLocation = { lat: e.latlng.lat, lng: e.latlng.lng };
    L.marker([userLocation.lat, userLocation.lng], { title: "現在地" }).addTo(map).bindPopup("現在地").openPopup();
});

// ズーム変更時の処理: バス停の表示を更新 (最大30個)
map.on("zoomend", () => {
    const newZoom = map.getZoom();
    if (newZoom !== currentZoomLevel) {
        currentZoomLevel = newZoom;
        if (busStopsAll.length) {
            drawBusStopsOnView(busStopsAll, 30);
        }
    }
});

// ===========================
// ORS: 徒歩ルート取得 
// ===========================
async function getWalkingRoute(start, end) {
    if (!ORS_API_KEY || ORS_API_KEY.startsWith("REPLACE_WITH")) {
        throw new Error("ORS_API_KEY を app.js に設定してください。ルート検索機能は現在利用できません。");
    }

    const url = "https://api.openrouteservice.org/v2/directions/foot-walking/geojson";
    const body = {
        coordinates: [
            [start.lng, start.lat],
            [end.lng, end.lat]
        ]
    };

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": ORS_API_KEY,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const txt = await res.text();
        throw new Error("ORS error " + res.status + ": " + txt);
    }

    const data = await res.json();
    if (!data.features || !data.features.length) return null;
    const coords = data.features[0].geometry.coordinates; // [lng,lat]
    return coords.map(c => [c[1], c[0]]); // convert to [lat,lng]
}

// ===========================
// Overpass: 広電バス路線 & 停留所取得 (取得範囲拡大済み)
// ===========================
async function fetchBusDataOverpass() {
    // 広島市中心部からやや広域
    const bbox = { south: 34.3700, west: 132.4200, north: 34.4200, east: 132.5000 }; 
    const url = "https://overpass-api.de/api/interpreter";

    // 1) relations (route=bus)
    const qRoutes = `[out:json][timeout:60];relation["route"="bus"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});out body;>;out geom;`;
    let resRoutes;
    try {
        resRoutes = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: qRoutes });
    } catch (err) {
        console.error("Overpass routes fetch failed", err);
        return { routes: {}, stops: [] };
    }
    const dataRoutes = await resRoutes.json();
    const elements = dataRoutes.elements || [];
    const waysById = new Map();
    for (const el of elements) {
        if (el.type === "way" && Array.isArray(el.geometry)) {
            waysById.set(el.id, el.geometry.map(pt => [pt.lat, pt.lon]));
        }
    }
    const routes = {};
    for (const el of elements) {
        if (el.type !== "relation") continue;
        const tags = el.tags || {};
        const idKey = (tags.ref || tags.name || ("route_" + el.id)).replace(/\s+/g, "_");
        const coords = [];
        const members = el.members || [];
        for (const m of members) {
            if (m.type === "way" && waysById.has(m.ref)) {
                const wayGeom = waysById.get(m.ref);
                if (coords.length === 0) coords.push(...wayGeom);
                else {
                    const last = coords[coords.length - 1];
                    const firstNew = wayGeom[0];
                    if (!(Math.abs(last[0] - firstNew[0]) < 1e-8 && Math.abs(last[1] - firstNew[1]) < 1e-8)) {
                        coords.push(...wayGeom);
                    } else coords.push(...wayGeom.slice(1));
                }
            }
        }
        if (coords.length) routes[idKey] = coords.map(c => ({ lat: c[0], lng: c[1] }));
    }

    // 2) stops
    const qStops = `[out:json][timeout:60];(node["highway"="bus_stop"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});node["public_transport"="platform"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out body;`;
    let resStops;
    try {
        resStops = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: qStops });
    } catch (err) {
        console.error("Overpass stops fetch failed", err);
        return { routes, stops: [] };
    }
    if (!resStops.ok) {
        console.error("Overpass stops HTTP", resStops.status);
        return { routes, stops: [] };
    }
    const dataStops = await resStops.json();
    const stops = (dataStops.elements || []).map(n => ({
        id: n.id,
        name: (n.tags && (n.tags.name || n.tags.ref)) || "bus stop",
        lat: n.lat,
        lng: n.lon
    }));

    return { routes, stops };
}

// ===========================
// バス停描画 (ズーム/制限付き - 最大30個)
// ===========================
function drawBusStopsOnView(allStops, maxLimit) {
    limitedBusStopMarkers.forEach(m => map.removeLayer(m));
    limitedBusStopMarkers = [];

    if (map.getZoom() < 15) {
        return;
    }

    const center = map.getCenter();
    const mapBounds = map.getBounds();
    
    const visibleStops = allStops
        .filter(s => mapBounds.contains([s.lat, s.lng]))
        .map(s => ({
            ...s,
            distanceToCenter: map.distance(center, [s.lat, s.lng])
        }))
        .sort((a, b) => a.distanceToCenter - b.distanceToCenter);

    const stopsToDraw = visibleStops.slice(0, maxLimit);
    
    // 黄色い●マーカーを描画
    stopsToDraw.forEach(s => {
        const marker = L.circleMarker([s.lat, s.lng], { 
            radius: 5,
            color: "#333333",
            fillColor: "yellow",
            fillOpacity: 0.8,
            weight: 2
        }).addTo(map).bindPopup(`<b>停留所</b><br>${s.name}`);
        
        limitedBusStopMarkers.push(marker);
    });
}

// ===========================
// Utility: 最も近いバス停を見つける (500m以内)
// ===========================
function findNearestStop(point, allStops) {
    let nearest = null;
    let minDistance = Infinity;

    for (const stop of allStops) {
        const distance = map.distance(point, { lat: stop.lat, lng: stop.lng });
        if (distance < minDistance) {
            minDistance = distance;
            nearest = stop;
        }
    }
    // 500m以内
    return minDistance < 500 ? nearest : null;
}

// ===========================
// 危険ポイント判定（根拠付き）
// ===========================
function detectDangerPoints(path) {
    const risky = [];
    if (!path || path.length < 3) return risky;

    const toRad = Math.PI / 180;
    function angle(a,b,c){
        const lat1=a[0]*toRad, lon1=a[1]*toRad;
        const lat2=b[0]*toRad, lon2=b[1]*toRad;
        const lat3=c[0]*toRad, lon3=c[1]*toRad;
        const v1 = [lat1-lat2, lon1-lon2];
        const v2 = [lat3-lat2, lon3-lon2];
        const dot = v1[0]*v2[0] + v1[1]*v2[1];
        const n1 = Math.hypot(v1[0], v1[1]), n2 = Math.hypot(v2[0], v2[1]);
        if (n1===0||n2===0) return 180;
        const cos = Math.max(-1, Math.min(1, dot/(n1*n2)));
        return Math.acos(cos) * (180/Math.PI);
    }

    for (let i=1;i<path.length-1;i++){
        const a = path[i-1], b = path[i], c = path[i+1];
        const ang = angle(a,b,c);
        if (ang < 55) {
            risky.push({ index: i, reason: `急な曲がり角 (角度: ${ang.toFixed(0)}度未満)` });
        }
    }

    let shortCount=0;
    for (let i=1;i<path.length;i++){
        const d = map.distance({lat: path[i-1][0], lng: path[i-1][1]}, {lat: path[i][0], lng: path[i][1]});
        if (d < 12) { 
             risky.push({ index: i, reason: `短い経路セグメントが連続 (距離: ${d.toFixed(1)}m未満)` }); 
             shortCount++; 
        }
    }
    
    if (shortCount > 6) {
        const centerIndex = Math.floor(path.length/2);
        const alreadyAdded = risky.some(r => r.index === centerIndex);
        if (!alreadyAdded) {
            risky.push({ index: centerIndex, reason: "多数の短いセグメントがあり、複雑な経路の可能性がある" });
        }
    }

    const uniqueMap = new Map();
    for (const item of risky) {
        if (!uniqueMap.has(item.index)) {
            uniqueMap.set(item.index, item);
        }
    }

    return Array.from(uniqueMap.values()).filter(item => item.index > 0 && item.index < path.length);
}

// ===========================
// 複合ルートの描画とマーカー配置
// ===========================
function renderCombinedRoute(walk1, bus, walk2, startStop, endStop, startPointName) {
    window.clearAllOverlays();
    
    // 徒歩ルート1 (出発地 -> 乗車バス停): 青色
    const routeWalk1 = L.polyline(walk1, { color: "blue", weight: 5, opacity: 0.8 }).addTo(map);

    // バスルート (乗車バス停 -> 降車バス停): 赤色の破線
    const routeBus = L.polyline(bus, { color: "red", weight: 5, opacity: 0.8, dashArray: "10, 10" }).addTo(map);

    // 徒歩ルート2 (降車バス停 -> 目的地): 青色
    const routeWalk2 = L.polyline(walk2, { color: "blue", weight: 5, opacity: 0.8 }).addTo(map);

    // --- 乗降地点マーカーの追加 ---
    const busIcon = L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/1183/1183204.png', 
        iconSize: [32, 32],
        iconAnchor: [16, 32]
    });
    
    // 乗車地点マーカー
    L.marker([startStop.lat, startStop.lng], { icon: busIcon, title: "乗車" })
        .addTo(map)
        .bindPopup(`<b>乗車地点</b><br>ここでバスに乗ります: ${startStop.name}`)
        .openPopup();

    // 降車地点マーカー
    L.marker([endStop.lat, endStop.lng], { icon: busIcon, title: "降車" })
        .addTo(map)
        .bindPopup(`<b>降車地点</b><br>ここでバスを降ります: ${endStop.name}`);
        
    // 出発地マーカー (walk1[0]が出発地の座標)
    L.marker(walk1[0], { title: startPointName, opacity: 0.7 })
        .addTo(map)
        .bindPopup(`<b>出発地</b><br>${startPointName}`);


    // --- 危険ポイント判定と描画 ---
    const fullWalkPath = walk1.concat(walk2);
    const riskData = detectDangerPoints(fullWalkPath); 
    
    riskData.forEach(item => {
        const latlng = fullWalkPath[item.index];
        const mk = L.circleMarker(latlng, { radius: 7, color: "black", fillColor: "red", fillOpacity: 0.9 })
            .addTo(map)
            .bindPopup(`<b>危険推定 (徒歩区間)</b><br>根拠: ${item.reason}`);
        dangerMarkers.push(mk);
    });

    // ルート全体にフィット
    map.fitBounds(L.featureGroup([routeWalk1, routeBus, routeWalk2]).getBounds());
}

// ===========================
// 行き先決定（広島駅固定）
// ===========================
document.getElementById("destination-ok").onclick = async () => {
    try {
        const goalKey = document.getElementById("destination-list").value;
        const end = destinations[goalKey];

        if (!end) { alert("目的地が未対応です"); return; }
        
        // ★修正：出発地を広島駅に固定し、不要な start-list の参照を削除
        const startPoint = hiroshimaStation;
        const startPointName = hiroshimaStation.name;
        
        // UIの無効化
        const okBtn = document.getElementById("destination-ok");
        if (okBtn) { okBtn.disabled = true; okBtn.textContent = "取得中..."; }

        // --- バス・徒歩連携ルート計算 ---
        const nearestStartStop = findNearestStop(startPoint, busStopsAll);
        const nearestEndStop = findNearestStop(end, busStopsAll);

        if (!nearestStartStop || !nearestEndStop) {
             alert(`出発地（${startPointName}）または目的地から500m以内にバス停が見つからなかったため、複合ルートを作成できませんでした。`);
             return;
        }

        const walk1Coords = await getWalkingRoute(startPoint, nearestStartStop);
        const walk2Coords = await getWalkingRoute(nearestEndStop, end);

        if (!walk1Coords || !walk2Coords) {
             alert("徒歩ルートの一部取得に失敗しました。OpenRouteServiceの接続を確認してください。");
             return;
        }

        // 実際のバス路線データからバスルートを探索・取得 (バスウェイの距離判定を強化)
        let busCoords = [[nearestStartStop.lat, nearestStartStop.lng], [nearestEndStop.lat, nearestEndStop.lng]];
        let busRouteFound = false;

        for (const routeKey in busRoutesDynamic) {
             const route = busRoutesDynamic[routeKey];
             
             // 乗車バス停と降車バス停がこのウェイの近くにあるかをチェック (150m以内)
             let startNear = false;
             let endNear = false;
             
             for (const coord of route) {
                 if (map.distance(coord, nearestStartStop) < 150) startNear = true;
                 if (map.distance(coord, nearestEndStop) < 150) endNear = true;
                 if (startNear && endNear) break;
             }

             if (startNear && endNear) {
                 busCoords = route.map(p => [p.lat, p.lng]);
                 busRouteFound = true;
                 console.log(`Note: 実際のバスウェイ(${routeKey})を使用します。`);
                 break;
             }
        }

        if (!busRouteFound) {
            console.log("Warning: 最適なバスウェイが見つからなかったため、直線ルートを使用します。");
        }
        
        // 描画実行
        renderCombinedRoute(walk1Coords, busCoords, walk2Coords, nearestStartStop, nearestEndStop, startPointName);
        drawBusStopsOnView(busStopsAll, 30); 

    } catch (err) {
        console.error("applyDestination error:", err);
        alert("ルート取得に失敗しました: " + (err.message || err));
    } finally {
        // UIの有効化
        const okBtn = document.getElementById("destination-ok");
        if (okBtn) { okBtn.disabled = false; okBtn.textContent = "決定"; }
        const destinationPopup = document.getElementById("destination-popup");
        if (destinationPopup) destinationPopup.classList.add("hidden");
        const overlay = document.getElementById("overlay");
        if (overlay) overlay.classList.add("hidden");
    }
};

// ===========================
// ボタン / ポップアップ制御
// ===========================
document.getElementById("destination-btn").onclick = () => {
    const p = document.getElementById("destination-popup");
    if (p) { p.classList.remove("hidden"); }
    const o = document.getElementById("overlay");
    if (o) o.classList.remove("hidden");
};
document.getElementById("destination-close").onclick = () => {
    const p = document.getElementById("destination-popup");
    if (p) p.classList.add("hidden");
    const o = document.getElementById("overlay");
    if (o) o.classList.add("hidden");
};
document.getElementById("bus-btn").onclick = () => {
    const p = document.getElementById("bus-popup");
    if (p) p.classList.remove("hidden");
    const o = document.getElementById("overlay");
    if (o) o.classList.remove("hidden");
};
document.getElementById("bus-close").onclick = () => {
    const p = document.getElementById("bus-popup");
    if (p) p.classList.add("hidden");
    const o = document.getElementById("overlay");
    if (o) o.classList.add("hidden");
};
document.getElementById("locate-btn").onclick = () => {
    map.locate({ setView: true, maxZoom: 16 });
};
document.getElementById("bus-scan").onclick = () => {
    window.open("https://claude.ai/public/artifacts/63026554-e18f-478c-af90-3a35ccbf8e75", "_blank");
};
const overlayEl = document.getElementById("overlay");
if (overlayEl) overlayEl.addEventListener("click", () => {
    const p1 = document.getElementById("destination-popup");
    const p2 = document.getElementById("bus-popup");
    if (p1) p1.classList.add("hidden");
    if (p2) p2.classList.add("hidden");
    overlayEl.classList.add("hidden");
});

// ===========================
// ページ初回ロード時に Overpass で bus data を取りに行く
// ===========================
(async function initBusData(){
    try {
        const { routes, stops } = await fetchBusDataOverpass();
        busRoutesDynamic = routes;
        busStopsAll = stops;
        
        if (stops.length) { 
            drawBusStopsOnView(stops, 30);
            console.log("Loaded bus routes:", Object.keys(routes).length, "stops:", stops.length);
        } else {
            console.warn("No bus stops loaded from Overpass in bbox.");
        }
    } catch (e) {
        console.error("initBusData failed:", e);
    }
})();

// ===========================
// Utility: remove all overlays 
// ===========================
window.clearAllOverlays = function(){
    map.eachLayer(layer => {
        if (layer instanceof L.Polyline || layer instanceof L.Marker || layer instanceof L.CircleMarker) {
            // 現在地マーカー（'現在地'タイトル）は残す
            if (!(layer instanceof L.Marker && layer.options.title === "現在地")) {
                map.removeLayer(layer);
            }
        }
    });

    dangerMarkers = [];
    limitedBusStopMarkers = [];
    busRouteLayers = {};
};