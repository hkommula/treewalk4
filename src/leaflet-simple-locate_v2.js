/**
 * Leaflet SimpleLocate v2 - A lightweight geolocation helper for Leaflet.
 * Provides user location tracking, heading/orientation, and accuracy display.
 */

(function(global, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('leaflet'));
    } else if (typeof define === 'function' && define.amd) {
        define(['leaflet'], factory);
    } else {
        global.SimpleLocate = factory(global.L);
    }
}(typeof self !== 'undefined' ? self : this, function(L) {
    'use strict';

    const SimpleLocate = L.Control.extend({
        options: {
            position: 'topright',
            className: 'button-locate',
            button: null,
            drawMarker: true,
            drawAccuracy: true,
            drawOrientation: true,
            markerColor: '#3b82f6',
            markerSize: 34,
            accuracyColor: '#3b82f6',
            accuracyFillColor: '#3b82f6',
            accuracyFillOpacity: 0.12,
            accuracyWeight: 1.5,
            zIndexOffset: 1000,
            highAccuracy: true,
            timeout: 15000,
            maximumAge: 5000,
            geofenceRadius: 2000,
            geofenceCenter: null,
            onLocationFound: null,
            onLocationError: null,
            onGeofenceViolation: null
        },

        initialize: function(options) {
            L.Util.setOptions(this, options);
            this.tracking = false;
            this.userMarker = null;
            this.accuracyCircle = null;
            this.watchId = null;
            this.userLocation = null;
            this.heading = null;
            this._button = null;
            this._container = null;
            this._boundButton = null;
            this._boundClick = null;
            this._boundOrientation = null;
            this._styleInjected = false;
        },

        onAdd: function(map) {
            this.map = map;
            this._createButton();
            this._injectStyles();
            return this._container;
        },

        onRemove: function() {
            this._stopTracking();
            this._unbindButton();
        },

        attachTo: function(map) {
            this.map = map;
            if (this.options.button) this._bindButton(this.options.button);
            this._injectStyles();
            return this;
        },

        start: function() {
            this._startTracking();
            return this;
        },

        stop: function() {
            this._stopTracking();
            return this;
        },

        toggle: function() {
            this._toggle();
            return this;
        },

        isTracking: function() {
            return this.tracking;
        },

        getLocation: function() {
            return this.userLocation;
        },

        setGeofenceCenter: function(latlng) {
            this.options.geofenceCenter = [latlng.lat || latlng[0], latlng.lng || latlng[1]];
            return this;
        },

        _createButton: function() {
            if (this.options.button) {
                this._container = L.DomUtil.create('div', 'simple-locate-external-control');
                this._container.style.display = 'none';
                this._bindButton(this.options.button);
                return this._container;
            }

            this._container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
            this._button = L.DomUtil.create('button', this.options.className, this._container);
            this._button.innerHTML = '<i class="bi bi-crosshair"></i>';
            this._button.title = 'Track my location';
            this._button.setAttribute('aria-label', 'Track my location');
            this._statusLight = L.DomUtil.create('span', 'gps-status-light', this._button);
            this._bindButton(this._button);
            return this._container;
        },

        _resolveButton: function(button) {
            if (typeof button === 'string') return document.querySelector(button);
            return button;
        },

        _bindButton: function(button) {
            const resolvedButton = this._resolveButton(button);
            if (!resolvedButton || this._boundButton === resolvedButton) return;

            this._unbindButton();
            this._button = resolvedButton;
            this._boundButton = resolvedButton;
            this._statusLight = resolvedButton.querySelector('.gps-status-light');
            if (!this._statusLight) {
                this._statusLight = L.DomUtil.create('span', 'gps-status-light', resolvedButton);
            }

            this._boundClick = (event) => {
                L.DomEvent.preventDefault(event);
                L.DomEvent.stopPropagation(event);
                this._toggle();
            };
            L.DomEvent.on(resolvedButton, 'click', this._boundClick);
            L.DomEvent.disableClickPropagation(resolvedButton);
        },

        _unbindButton: function() {
            if (this._boundButton && this._boundClick) {
                L.DomEvent.off(this._boundButton, 'click', this._boundClick);
            }
            this._boundButton = null;
            this._boundClick = null;
        },

        _toggle: function() {
            if (this.tracking) {
                this._stopTracking();
            } else {
                this._startTracking();
            }
        },

        _startTracking: function() {
            if (this.tracking) return;
            if (!navigator.geolocation) {
                this._handleError({ message: 'Geolocation not supported.' });
                return;
            }

            this.tracking = true;
            this._updateButtonState('locating');
            this._startOrientationWatch();

            this.watchId = navigator.geolocation.watchPosition(
                (position) => this._onLocationFound(position),
                (error) => this._onLocationError(error),
                {
                    enableHighAccuracy: this.options.highAccuracy,
                    timeout: this.options.timeout,
                    maximumAge: this.options.maximumAge
                }
            );
        },

        _stopTracking: function() {
            const wasTracking = this.tracking || this.watchId !== null || this.userMarker || this.accuracyCircle;
            this.tracking = false;
            this._updateButtonState('off');
            this.userLocation = null;
            this.heading = null;

            if (this.watchId !== null) {
                navigator.geolocation.clearWatch(this.watchId);
                this.watchId = null;
            }
            this._stopOrientationWatch();

            if (this.userMarker) {
                this.map.removeLayer(this.userMarker);
                this.userMarker = null;
            }
            if (this.accuracyCircle) {
                this.map.removeLayer(this.accuracyCircle);
                this.accuracyCircle = null;
            }

            if (wasTracking && typeof this.options.onLocationError === 'function') {
                this.options.onLocationError({ type: 'stopped' });
            }
        },

        _onLocationFound: function(position) {
            const gpsHeading = this._normalizeHeading(position.coords.heading);
            this.userLocation = {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                accuracy: position.coords.accuracy,
                heading: gpsHeading === null ? this.heading : gpsHeading,
                timestamp: position.timestamp
            };

            if (this.options.geofenceCenter && this.options.geofenceRadius) {
                const distance = this._getDistance(
                    this.userLocation.lat,
                    this.userLocation.lng,
                    this.options.geofenceCenter[0],
                    this.options.geofenceCenter[1]
                );

                if (distance > this.options.geofenceRadius) {
                    if (typeof this.options.onGeofenceViolation === 'function') {
                        this.options.onGeofenceViolation({
                            distance: distance,
                            limit: this.options.geofenceRadius,
                            location: this.userLocation
                        });
                    }
                    this._stopTracking();
                    return;
                }
            }

            this._updateButtonState('active');
            this._updateUserMarker();

            if (typeof this.options.onLocationFound === 'function') {
                this.options.onLocationFound(this.userLocation);
            }
        },

        _onLocationError: function(error) {
            this.tracking = false;
            this._updateButtonState('off');
            this.userLocation = null;
            this.heading = null;

            if (this.watchId !== null) {
                navigator.geolocation.clearWatch(this.watchId);
                this.watchId = null;
            }
            this._stopOrientationWatch();

            if (this.userMarker) {
                this.map.removeLayer(this.userMarker);
                this.userMarker = null;
            }
            if (this.accuracyCircle) {
                this.map.removeLayer(this.accuracyCircle);
                this.accuracyCircle = null;
            }

            if (typeof this.options.onLocationError === 'function') {
                this.options.onLocationError(error);
            }
        },

        _handleError: function(error) {
            this._updateButtonState('off');
            if (typeof this.options.onLocationError === 'function') {
                this.options.onLocationError(error);
            }
        },

        _updateUserMarker: function() {
            if (!this.map || !this.userLocation) return;
            this._injectStyles();

            const latlng = [this.userLocation.lat, this.userLocation.lng];
            if (this.options.drawAccuracy && Number.isFinite(this.userLocation.accuracy)) {
                if (!this.accuracyCircle) {
                    this.accuracyCircle = L.circle(latlng, {
                        radius: this.userLocation.accuracy,
                        color: this.options.accuracyColor,
                        weight: this.options.accuracyWeight,
                        fillColor: this.options.accuracyFillColor,
                        fillOpacity: this.options.accuracyFillOpacity,
                        interactive: false
                    }).addTo(this.map);
                } else {
                    this.accuracyCircle
                        .setLatLng(latlng)
                        .setRadius(this.userLocation.accuracy);
                }
            } else if (this.accuracyCircle) {
                this.map.removeLayer(this.accuracyCircle);
                this.accuracyCircle = null;
            }

            if (!this.options.drawMarker) return;

            if (!this.userMarker) {
                this.userMarker = L.marker(latlng, {
                    icon: this._createLocationIcon(),
                    interactive: false,
                    zIndexOffset: this.options.zIndexOffset
                }).addTo(this.map);
            } else {
                this.userMarker.setLatLng(latlng);
            }
            this._updateMarkerHeading();
        },

        _createLocationIcon: function() {
            const size = this.options.markerSize;
            const color = this.options.markerColor;
            return L.divIcon({
                className: 'simple-locate-marker',
                iconSize: [size, size],
                iconAnchor: [size / 2, size / 2],
                html:
                    '<div class="simple-locate-puck" style="--simple-locate-color:' + color + '">' +
                        '<div class="simple-locate-heading"></div>' +
                        '<div class="simple-locate-dot"></div>' +
                    '</div>'
            });
        },

        _updateMarkerHeading: function() {
            if (!this.userMarker) return;
            const element = this.userMarker.getElement();
            if (!element) return;

            const puck = element.querySelector('.simple-locate-puck');
            if (!puck) return;

            const heading = this.userLocation?.heading ?? this.heading;
            const hasHeading = this.options.drawOrientation && Number.isFinite(heading);
            puck.style.setProperty('--simple-locate-heading', `${hasHeading ? heading : 0}deg`);
            puck.style.setProperty('--simple-locate-heading-opacity', hasHeading ? '1' : '0');
        },

        _startOrientationWatch: function() {
            if (!this.options.drawOrientation || typeof window === 'undefined' || this._boundOrientation) return;
            this._boundOrientation = (event) => this._onOrientation(event);

            const orientationEvent = window.DeviceOrientationEvent;
            if (orientationEvent && typeof orientationEvent.requestPermission === 'function') {
                orientationEvent.requestPermission()
                    .then((state) => {
                        if (state === 'granted' && this._boundOrientation) {
                            window.addEventListener('deviceorientation', this._boundOrientation, true);
                        } else {
                            this._boundOrientation = null;
                        }
                    })
                    .catch(() => {
                        this._boundOrientation = null;
                    });
                return;
            }

            window.addEventListener('deviceorientationabsolute', this._boundOrientation, true);
            window.addEventListener('deviceorientation', this._boundOrientation, true);
        },

        _stopOrientationWatch: function() {
            if (!this._boundOrientation || typeof window === 'undefined') return;
            window.removeEventListener('deviceorientationabsolute', this._boundOrientation, true);
            window.removeEventListener('deviceorientation', this._boundOrientation, true);
            this._boundOrientation = null;
        },

        _onOrientation: function(event) {
            let heading = null;
            if (Number.isFinite(event.webkitCompassHeading)) {
                heading = event.webkitCompassHeading;
            } else if (Number.isFinite(event.alpha)) {
                heading = 360 - event.alpha;
            }

            heading = this._normalizeHeading(heading);
            if (heading === null) return;

            this.heading = heading;
            if (this.userLocation) {
                this.userLocation.heading = heading;
                this._updateMarkerHeading();
            }
        },

        _normalizeHeading: function(value) {
            const heading = Number(value);
            if (!Number.isFinite(heading)) return null;
            return ((heading % 360) + 360) % 360;
        },

        _updateButtonState: function(state) {
            if (!this._button) return;
            this._button.classList.remove('active', 'locating', 'gps-active');

            if (state === 'locating') {
                this._button.classList.add('locating');
            } else if (state === 'active') {
                this._button.classList.add('gps-active');
            }
        },

        _getDistance: function(lat1, lon1, lat2, lon2) {
            const DEG = Math.PI / 180;
            const p1 = lat1 * DEG, p2 = lat2 * DEG;
            const dp = (lat2 - lat1) * DEG, dl = (lon2 - lon1) * DEG;
            const a = Math.sin(dp/2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2) ** 2;
            return 6371e3 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        },

        _injectStyles: function() {
            if (this._styleInjected || typeof document === 'undefined') return;
            if (document.getElementById('simple-locate-v2-style')) {
                this._styleInjected = true;
                return;
            }

            const style = document.createElement('style');
            style.id = 'simple-locate-v2-style';
            style.textContent = `
                .simple-locate-marker {
                    background: transparent;
                    border: 0;
                }
                .simple-locate-puck {
                    --simple-locate-heading: 0deg;
                    --simple-locate-heading-opacity: 0;
                    position: relative;
                    width: 34px;
                    height: 34px;
                    transform: rotate(var(--simple-locate-heading));
                    transform-origin: 50% 50%;
                    transition: transform .18s ease-out;
                }
                .simple-locate-heading {
                    position: absolute;
                    left: 50%;
                    top: 0;
                    width: 18px;
                    height: 24px;
                    transform: translateX(-50%);
                    background: color-mix(in srgb, var(--simple-locate-color, #3b82f6) 70%, transparent);
                    clip-path: polygon(50% 0, 100% 100%, 50% 74%, 0 100%);
                    filter: drop-shadow(0 2px 4px rgba(0,0,0,.35));
                    opacity: var(--simple-locate-heading-opacity);
                    transition: opacity .18s ease-out;
                }
                .simple-locate-dot {
                    position: absolute;
                    left: 50%;
                    top: 50%;
                    width: 16px;
                    height: 16px;
                    transform: translate(-50%, -50%);
                    border-radius: 50%;
                    background: var(--simple-locate-color, #3b82f6);
                    border: 3px solid #fff;
                    box-shadow: 0 2px 8px rgba(0,0,0,.35), 0 0 0 2px rgba(59,130,246,.25);
                }
            `;
            document.head.appendChild(style);
            this._styleInjected = true;
        }
    });

    return SimpleLocate;
}));
