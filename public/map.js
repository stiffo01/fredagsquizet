'use strict';
const quizMaps = [];
const mapViews = new Map();
function clearQuizMaps() {
  for (const {map, key} of quizMaps) { mapViews.set(key, {center:map.getCenter(), zoom:map.getZoom()}); map.remove(); }
  quizMaps.length = 0;
}
function mountQuizMap(element, {key, point, target, onSelect}) {
  const view = mapViews.get(key);
  const map = L.map(element, {worldCopyJump:true, minZoom:2, maxZoom:19}).setView(view?.center || (target || point || [20,0]), view?.zoom ?? (target || point ? 5 : 2));
  quizMaps.push({map, key});
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map).on('tileerror', () => {
    const status = element.parentElement.querySelector('[data-map-status]');
    if (status) status.textContent = 'Map tiles could not load. Check your internet connection; coordinates can still be entered below.';
  });
  const marker = (location, label, correct=false) => L.marker(location, {icon:L.divIcon({className:'quiz-map-pin', html:correct?'🎯':'📍', iconSize:[30,36], iconAnchor:[15,32]}), title:label}).addTo(map).bindTooltip(label);
  let selected = point ? marker(point, 'Your pin') : null;
  if (target) marker(target, 'Correct location', true);
  if (point && target) {
    L.polyline([point,target], {color:'#46178f',dashArray:'6 6'}).addTo(map);
    map.fitBounds(L.latLngBounds([point,target]), {padding:[40,40],maxZoom:12});
  }
  const select = location => {
    if (!onSelect) return;
    const wrapped = L.latLng(Math.max(-90,Math.min(90,location.lat)), location.lng).wrap();
    const value = {lat:wrapped.lat, lng:wrapped.lng};
    if (selected) selected.setLatLng(value); else selected = marker(value, 'Your pin');
    onSelect(value);
  };
  if (onSelect) {
    map.on('click', event => select(event.latlng));
    element.addEventListener('keydown', event => {
      if (event.target === element && event.key === 'Enter') { event.preventDefault(); select(map.getCenter()); }
    });
  }
  return {select};
}
function locationFields(point) {
  return `<div class="map-coordinates"><label>Latitude<input class="input" data-lat type="number" min="-90" max="90" step="any" required value="${point?.lat ?? ''}"></label><label>Longitude<input class="input" data-lng type="number" min="-180" max="180" step="any" required value="${point?.lng ?? ''}"></label></div>`;
}
function readLocation(element) {
  const lat = element.querySelector('[data-lat]'), lng = element.querySelector('[data-lng]');
  return lat?.value !== '' && lng?.value !== '' && lat?.validity.valid && lng?.validity.valid ? {lat:Number(lat.value),lng:Number(lng.value)} : undefined;
}
function wireLocationFields(container, widget) {
  container.querySelectorAll('[data-lat], [data-lng]').forEach(input => input.addEventListener('change', () => {
    const point = readLocation(container); if (point) widget.select(point);
  }));
}
function setLocationFields(container, point) {
  container.querySelector('[data-lat]').value = point.lat;
  container.querySelector('[data-lng]').value = point.lng;
}
