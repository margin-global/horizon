import { Component } from '@theme/component';

/**
 * Configuration defaults for the stockist locator
 */
const DEFAULT_CONFIG = {
  defaultCenter: [40.7128, -74.006],
  defaultZoom: 12,
  mapboxToken: 'pk.eyJ1IjoibWFyZ2luZ2xvYmFsIiwiYSI6ImNtazc3Z3A1ajEyaW8zY291NThlcnc1czAifQ.7MNjFR8shMk1WTp7z3Qn9w',
  geocodeUrl: 'https://nominatim.openstreetmap.org/search',
  debounceDelay: 300,
  minChars: 3,
  distanceOptions: [5, 10, 25, 50, 100, null],
  defaultDistance: null,
};

/**
 * Debounce utility function
 * @param {Function} func - Function to debounce
 * @param {number} wait - Delay in milliseconds
 * @returns {Function} Debounced function
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {number} lat1 - Latitude of first point
 * @param {number} lon1 - Longitude of first point
 * @param {number} lat2 - Latitude of second point
 * @param {number} lon2 - Longitude of second point
 * @returns {number} Distance in miles
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth's radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Convert degrees to radians
 * @param {number} deg - Degrees
 * @returns {number} Radians
 */
function toRad(deg) {
  return deg * (Math.PI / 180);
}

/**
 * Format distance for display
 * @param {number} miles - Distance in miles
 * @returns {string} Formatted distance string
 */
function formatDistance(miles) {
  if (miles < 0.1) {
    return 'Nearby';
  } else if (miles < 1) {
    return `${(miles * 5280).toFixed(0)} ft`;
  }
  return `${miles.toFixed(1)} mi`;
}

/**
 * Escape HTML to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeHTML(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * @typedef {object} StockistLocatorRefs
 * @property {HTMLInputElement} input - Search input
 * @property {HTMLButtonElement} searchBtn - Search button
 * @property {HTMLButtonElement} clearBtn - Clear button
 * @property {HTMLElement} autocomplete - Autocomplete results container
 * @property {HTMLElement} list - Stockist list container
 * @property {HTMLElement} map - Map container
 * @property {HTMLButtonElement} geolocationBtn - Geolocation button
 * @property {HTMLButtonElement} shareBtn - Share button
 * @property {HTMLElement} count - Store count display
 * @property {HTMLSelectElement} distanceFilter - Distance filter select
 * @property {HTMLElement} announcer - ARIA live region for announcements
 */

/**
 * Stockist Locator Component
 *
 * Interactive store locator with map integration, search, and filtering.
 *
 * @extends {Component<StockistLocatorRefs>}
 */
export class StockistLocatorComponent extends Component {
  requiredRefs = ['input', 'searchBtn', 'list', 'map'];

  /** @type {Map} */
  mapInstance = null;

  /** @type {Map<number, object>} */
  markers = new Map();

  /** @type {object|null} */
  userMarker = null;

  /** @type {{lat: number, lng: number}|null} */
  userLocation = null;

  /** @type {number|null} */
  selectedStockist = null;

  /** @type {object[]} */
  allStockists = [];

  /** @type {object[]} */
  stockists = [];

  /** @type {number} */
  highlightedIndex = -1;

  /** @type {number|null} */
  distanceFilter = null;

  /** @type {boolean} */
  mapLoaded = false;

  /** @type {object|null} */
  activePopup = null;

  /** @type {string} */
  baseColor = '#666666';

  /** @type {AbortController|null} */
  searchController = null;

  /** @type {IntersectionObserver|null} */
  intersectionObserver = null;

  /** @type {boolean} */
  initialized = false;

  /** @type {Function} */
  debouncedAutocomplete = null;

  connectedCallback() {
    super.connectedCallback();

    const config = { ...DEFAULT_CONFIG, ...(window.STOCKIST_CONFIG || {}) };
    this.config = config;
    this.distanceFilter = config.defaultDistance;

    // Load stockist data from global
    this.allStockists = window.STOCKIST_DATA || [];
    // Filter to only stockists with valid coordinates
    this.stockists = this.allStockists.filter((s) => s.lat && s.lng && s.lat !== 0);

    // Set up debounced autocomplete
    this.debouncedAutocomplete = debounce((query) => this.#handleAutocomplete(query), this.config.debounceDelay);

    // Set up intersection observer for lazy loading
    this.#setupIntersectionObserver();
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    // Clean up
    this.searchController?.abort();
    this.intersectionObserver?.disconnect();

    if (this.mapInstance) {
      this.mapInstance.remove();
      this.mapInstance = null;
    }
  }

  /**
   * Set up intersection observer for lazy map loading
   */
  #setupIntersectionObserver() {
    if (this.initialized) return;

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !this.initialized) {
          this.initialized = true;
          this.intersectionObserver.disconnect();
          this.#initialize();
        }
      },
      { rootMargin: '200px' }
    );

    this.intersectionObserver.observe(this);
  }

  /**
   * Initialize the component after lazy load trigger
   */
  async #initialize() {
    this.#createDistanceFilter();
    await this.#loadMapbox();
    this.#initMap();
    this.#renderStockists();
    this.#addMarkers();
    this.#fitMapToMarkers();
    this.#restoreFromURL();
  }

  /**
   * Load Mapbox GL JS library
   */
  async #loadMapbox() {
    if (window.mapboxgl) return;

    return new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.href = 'https://api.mapbox.com/mapbox-gl-js/v3.4.0/mapbox-gl.css';
      link.rel = 'stylesheet';
      document.head.appendChild(link);

      const script = document.createElement('script');
      script.src = 'https://api.mapbox.com/mapbox-gl-js/v3.4.0/mapbox-gl.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  /**
   * Initialize the Mapbox map
   */
  #initMap() {
    mapboxgl.accessToken = this.config.mapboxToken;

    const center = this.config.defaultCenter;
    const zoom = this.config.defaultZoom;

    this.baseColor = this.#getBaseColor();

    this.mapInstance = new mapboxgl.Map({
      container: this.refs.map,
      center: [center[1], center[0]],
      zoom: zoom,
      style: 'mapbox://styles/mapbox/light-v11',
      attributionControl: true,
    });

    this.mapInstance.on('load', () => {
      this.mapLoaded = true;
      this.#applyMonotoneStyle();
    });

    this.mapInstance.addControl(new mapboxgl.NavigationControl(), 'top-right');
  }

  /**
   * Get the base color from CSS custom property
   * @returns {string} Hex color
   */
  #getBaseColor() {
    const computed = getComputedStyle(this);
    const baseColor = computed.getPropertyValue('--map-color').trim();
    return baseColor || '#666666';
  }

  /**
   * Convert hex color to HSL
   * @param {string} hex - Hex color
   * @returns {{h: number, s: number, l: number}} HSL values
   */
  #hexToHSL(hex) {
    const normalized = hex.replace('#', '');
    const r = parseInt(normalized.substr(0, 2), 16) / 255;
    const g = parseInt(normalized.substr(2, 2), 16) / 255;
    const b = parseInt(normalized.substr(4, 2), 16) / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;

    if (max === min) {
      return { h: 0, s: 0, l: lightness * 100 };
    }

    const delta = max - min;
    const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);

    let hue;
    if (max === r) {
      hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
    } else if (max === g) {
      hue = ((b - r) / delta + 2) / 6;
    } else {
      hue = ((r - g) / delta + 4) / 6;
    }

    return { h: hue * 360, s: saturation * 100, l: lightness * 100 };
  }

  /**
   * Format HSL values to CSS string
   * @param {number} hue
   * @param {number} saturation
   * @param {number} lightness
   * @returns {string} CSS HSL string
   */
  #formatHSL(hue, saturation, lightness) {
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }

  /**
   * Apply monotone styling to the map
   */
  #applyMonotoneStyle() {
    const { h: hue } = this.#hexToHSL(this.baseColor);
    const saturation = 5;

    const palette = {
      background: this.#formatHSL(hue, saturation, 96),
      backgroundAlt: this.#formatHSL(hue, saturation, 92),
      water: this.#formatHSL(hue, saturation, 88),
      building: this.#formatHSL(hue, saturation, 90),
      roadMinor: this.#formatHSL(hue, saturation, 100),
      roadMajor: this.#formatHSL(hue, saturation, 98),
      roadHighway: this.#formatHSL(hue, saturation, 85),
      border: this.#formatHSL(hue, saturation, 75),
      textDark: this.#formatHSL(hue, saturation, 35),
      textMid: this.#formatHSL(hue, saturation, 50),
      textLight: this.#formatHSL(hue, saturation, 65),
    };

    const layers = this.mapInstance.getStyle().layers;

    for (const layer of layers) {
      this.#applyLayerStyle(layer, palette);
    }
  }

  /**
   * Apply palette styling to a map layer
   * @param {object} layer - Mapbox layer
   * @param {object} palette - Color palette
   */
  #applyLayerStyle(layer, palette) {
    const { id, type } = layer;

    const setPaint = (property, color) => {
      try {
        this.mapInstance.setPaintProperty(id, property, color);
      } catch {
        // Layer may not support this paint property
      }
    };

    if (id === 'background') {
      setPaint('background-color', palette.background);
      return;
    }

    if (id.includes('water')) {
      if (type === 'fill') {
        setPaint('fill-color', palette.water);
      } else if (type === 'line') {
        setPaint('line-color', palette.water);
      }
      return;
    }

    if (id.includes('land') || id.includes('park') || id.includes('grass')) {
      if (type === 'fill') {
        setPaint('fill-color', palette.backgroundAlt);
      }
      return;
    }

    if (id.includes('building')) {
      if (type === 'fill') {
        setPaint('fill-color', palette.building);
      } else if (type === 'line') {
        setPaint('line-color', palette.border);
      }
      return;
    }

    if (id.includes('road') || id.includes('street') || id.includes('tunnel') || id.includes('bridge')) {
      if (type === 'line') {
        let roadColor = palette.roadMinor;
        if (id.includes('motorway') || id.includes('trunk')) {
          roadColor = palette.roadHighway;
        } else if (id.includes('primary') || id.includes('secondary') || id.includes('tertiary')) {
          roadColor = palette.roadMajor;
        }
        setPaint('line-color', roadColor);
      }
      return;
    }

    if (id.includes('admin') || id.includes('boundary')) {
      if (type === 'line') {
        setPaint('line-color', palette.border);
      }
      return;
    }

    if (type === 'symbol') {
      if (id.includes('place') || id.includes('poi')) {
        setPaint('text-color', palette.textDark);
        setPaint('text-halo-color', palette.background);
      } else if (id.includes('road')) {
        setPaint('text-color', palette.textMid);
        setPaint('text-halo-color', palette.roadMinor);
      } else {
        setPaint('text-color', palette.textLight);
        setPaint('text-halo-color', palette.background);
      }
    }
  }

  /**
   * Create the distance filter dropdown
   */
  #createDistanceFilter() {
    const filterHtml = `
      <div class="stockist-locator__filters">
        <label for="distance-filter-${this.dataset.sectionId}" class="stockist-locator__filter-label">Show stores within:</label>
        <select ref="distanceFilter" class="stockist-locator__filter-select" on:change="/handleDistanceFilterChange">
          ${this.config.distanceOptions
            .map((d) => (d === null ? `<option value="">Any distance</option>` : `<option value="${d}">${d} miles</option>`))
            .join('')}
        </select>
      </div>
    `;

    const countEl = this.refs.count;
    if (countEl) {
      countEl.insertAdjacentHTML('afterend', filterHtml);
    }
  }

  /**
   * Restore state from URL parameters
   */
  #restoreFromURL() {
    const params = new URLSearchParams(window.location.search);
    const lat = params.get('lat');
    const lng = params.get('lng');
    const address = params.get('address');
    const distance = params.get('distance');

    if (lat && lng) {
      if (address) {
        this.refs.input.value = address;
      }
      this.#setUserLocation(parseFloat(lat), parseFloat(lng));
    }

    if (distance) {
      this.distanceFilter = distance === 'any' ? null : parseFloat(distance);
      const distanceSelect = this.querySelector('[ref="distanceFilter"]');
      if (distanceSelect) {
        distanceSelect.value = distance === 'any' ? '' : distance;
      }
      this.#renderStockists();
      this.#updateMarkers();
    }
  }

  /**
   * Update URL with current state
   */
  #updateURL() {
    const params = new URLSearchParams();

    if (this.userLocation) {
      params.set('lat', this.userLocation.lat.toFixed(6));
      params.set('lng', this.userLocation.lng.toFixed(6));

      const address = this.refs.input.value.trim();
      if (address) {
        params.set('address', address);
      }
    }

    if (this.distanceFilter !== null) {
      params.set('distance', this.distanceFilter);
    } else if (this.userLocation) {
      params.set('distance', 'any');
    }

    const newURL = params.toString() ? `${window.location.pathname}?${params.toString()}` : window.location.pathname;

    window.history.replaceState({}, '', newURL);
  }

  /**
   * Render the stockist list
   */
  #renderStockists() {
    this.#applyFilters();

    const html = this.stockists.map((stockist, index) => this.#createStockistHTML(stockist, index + 1)).join('');
    this.refs.list.innerHTML = html || this.#createEmptyStateHTML();
    this.#updateStoreCount();
  }

  /**
   * Apply distance and sorting filters
   */
  #applyFilters() {
    let filtered = this.allStockists.filter((s) => s.lat && s.lng && s.lat !== 0);

    if (this.userLocation) {
      filtered.sort((a, b) => {
        const distA = calculateDistance(this.userLocation.lat, this.userLocation.lng, a.lat, a.lng);
        const distB = calculateDistance(this.userLocation.lat, this.userLocation.lng, b.lat, b.lng);
        return distA - distB;
      });

      if (this.distanceFilter !== null) {
        filtered = filtered.filter((stockist) => {
          const dist = calculateDistance(this.userLocation.lat, this.userLocation.lng, stockist.lat, stockist.lng);
          return dist <= this.distanceFilter;
        });
      }
    }

    this.stockists = filtered;
  }

  /**
   * Update the store count display
   */
  #updateStoreCount() {
    if (!this.refs.count) return;

    const count = this.stockists.length;
    const total = this.allStockists.filter((s) => s.lat && s.lng && s.lat !== 0).length;

    if (this.userLocation) {
      const filterText = this.distanceFilter ? ` within ${this.distanceFilter} mi` : '';
      this.refs.count.textContent = `${count} of ${total} store${total !== 1 ? 's' : ''}${filterText}`;
    } else {
      this.refs.count.textContent = `${count} store${count !== 1 ? 's' : ''} available`;
    }

    // Announce to screen readers
    this.#announce(`${count} stores found`);
  }

  /**
   * Announce message to screen readers via ARIA live region
   * @param {string} message
   */
  #announce(message) {
    if (this.refs.announcer) {
      this.refs.announcer.textContent = message;
    }
  }

  /**
   * Create HTML for a single stockist item
   * @param {object} stockist
   * @param {number} index
   * @returns {string} HTML string
   */
  #createStockistHTML(stockist, index) {
    const addressParts = [stockist.address, stockist.city, stockist.country].filter(Boolean);
    const fullAddress = addressParts.join(', ');
    const distance = this.userLocation
      ? formatDistance(calculateDistance(this.userLocation.lat, this.userLocation.lng, stockist.lat, stockist.lng))
      : '';

    const directionsUrl =
      stockist.mapUrl || `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fullAddress)}`;

    return `
      <article
        class="stockist-locator__item"
        data-id="${stockist.id}"
        tabindex="0"
        aria-label="Store ${index}: ${escapeHTML(stockist.name)}"
        on:click="/handleStockistClick"
        on:keydown="/handleStockistKeydown"
      >
        <div class="stockist-locator__item-header">
          <span class="stockist-locator__item-number" aria-hidden="true">${index}</span>
          <h3 class="stockist-locator__item-name">${escapeHTML(stockist.name)}</h3>
          ${distance ? `<span class="stockist-locator__item-distance">${distance}</span>` : ''}
        </div>
        <p class="stockist-locator__item-address">${escapeHTML(fullAddress)}</p>
        <div class="stockist-locator__item-details">
          ${
            stockist.phone
              ? `<a href="tel:${stockist.phone}" class="stockist-locator__item-link" aria-label="Call ${escapeHTML(stockist.name)}">${escapeHTML(stockist.phone)}</a>`
              : ''
          }
          ${
            stockist.url
              ? `<a href="${escapeHTML(stockist.url)}" class="stockist-locator__item-link" target="_blank" rel="noopener" aria-label="Visit ${escapeHTML(stockist.name)} website">Website</a>`
              : ''
          }
          <a href="${directionsUrl}" class="stockist-locator__item-link" target="_blank" rel="noopener" aria-label="Get directions to ${escapeHTML(stockist.name)}">Directions</a>
        </div>
      </article>
    `;
  }

  /**
   * Create empty state HTML
   * @returns {string} HTML string
   */
  #createEmptyStateHTML() {
    return `
      <div class="stockist-locator__empty">
        <p>No stores found in this area.</p>
      </div>
    `;
  }

  /**
   * Add markers to the map
   */
  #addMarkers() {
    this.stockists.forEach((stockist, index) => {
      const marker = this.#createMarker(stockist, index + 1);
      this.markers.set(stockist.id, marker);
    });
  }

  /**
   * Update all markers
   */
  #updateMarkers() {
    this.markers.forEach((marker) => marker.remove());
    this.markers.clear();
    this.#addMarkers();
  }

  /**
   * Create a map marker
   * @param {object} stockist
   * @param {number} number
   * @returns {object} Mapbox marker
   */
  #createMarker(stockist, number) {
    const el = document.createElement('div');
    el.className = 'stockist-locator__marker';
    el.innerHTML = `<span class="stockist-locator__marker-number">${number}</span>`;

    const marker = new mapboxgl.Marker({
      element: el,
      anchor: 'center',
    })
      .setLngLat([stockist.lng, stockist.lat])
      .addTo(this.mapInstance);

    marker._element = el;
    marker._stockistId = stockist.id;
    marker._stockist = stockist;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#selectStockist(stockist.id);
    });

    return marker;
  }

  /**
   * Show popup for a stockist
   * @param {object} stockist
   */
  #showPopup(stockist) {
    if (this.activePopup) {
      this.activePopup.remove();
    }

    const addressParts = [stockist.address, stockist.city, stockist.country].filter(Boolean);
    const fullAddress = addressParts.join(', ');
    const popupHTML = `
      <div class="stockist-locator__popup">
        <div class="stockist-locator__popup-name">${escapeHTML(stockist.name)}</div>
        <div class="stockist-locator__popup-address">${escapeHTML(fullAddress)}</div>
        ${
          stockist.url
            ? `<a href="${escapeHTML(stockist.url)}" class="stockist-locator__popup-link" target="_blank" rel="noopener">Visit Website</a>`
            : ''
        }
      </div>
    `;

    this.activePopup = new mapboxgl.Popup({
      closeButton: true,
      closeOnClick: false,
      offset: 20,
    })
      .setLngLat([stockist.lng, stockist.lat])
      .setHTML(popupHTML)
      .addTo(this.mapInstance);
  }

  /**
   * Fit map bounds to show all markers
   */
  #fitMapToMarkers() {
    if (this.stockists.length === 0) return;

    const bounds = new mapboxgl.LngLatBounds();
    this.stockists.forEach((s) => bounds.extend([s.lng, s.lat]));

    this.mapInstance.fitBounds(bounds, {
      padding: 50,
      maxZoom: 15,
    });
  }

  /**
   * Set user location and update display
   * @param {number} lat
   * @param {number} lng
   */
  #setUserLocation(lat, lng) {
    this.userLocation = { lat, lng };

    if (this.userMarker) {
      this.userMarker.remove();
    }

    const el = document.createElement('div');
    el.className = 'stockist-locator__user-marker';

    this.userMarker = new mapboxgl.Marker({
      element: el,
      anchor: 'center',
    })
      .setLngLat([lng, lat])
      .addTo(this.mapInstance);

    this.#renderStockists();
    this.#updateMarkers();
    this.#centerOnUserWithStockists();
    this.#updateClearButton();
    this.#updateURL();
  }

  /**
   * Center map on user location with nearby stockists
   */
  #centerOnUserWithStockists() {
    if (!this.userLocation) return;

    const bounds = new mapboxgl.LngLatBounds();
    bounds.extend([this.userLocation.lng, this.userLocation.lat]);

    this.stockists.slice(0, 3).forEach((s) => {
      bounds.extend([s.lng, s.lat]);
    });

    this.mapInstance.fitBounds(bounds, {
      padding: 50,
      maxZoom: 15,
    });
  }

  /**
   * Update clear button visibility
   */
  #updateClearButton() {
    if (!this.refs.clearBtn) return;
    const hasValue = this.refs.input.value.trim() !== '' || this.userLocation;
    this.refs.clearBtn.hidden = !hasValue;

    if (this.refs.shareBtn) {
      this.refs.shareBtn.hidden = !this.userLocation;
    }
  }

  /**
   * Select a stockist
   * @param {number} id
   */
  #selectStockist(id) {
    // Deselect previous
    if (this.selectedStockist !== null) {
      const prevItem = this.refs.list.querySelector(`[data-id="${this.selectedStockist}"]`);
      if (prevItem) prevItem.classList.remove('stockist-locator__item--active');

      const prevMarker = this.markers.get(this.selectedStockist);
      if (prevMarker && prevMarker._element) {
        prevMarker._element.classList.remove('stockist-locator__marker--active');
      }
    }

    this.selectedStockist = id;

    // Select new
    const item = this.refs.list.querySelector(`[data-id="${id}"]`);
    if (item) {
      item.classList.add('stockist-locator__item--active');
      item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    const marker = this.markers.get(id);
    if (marker) {
      if (marker._element) {
        marker._element.classList.add('stockist-locator__marker--active');
      }

      const stockist = this.stockists.find((s) => s.id === id);
      if (stockist) {
        this.#showPopup(stockist);

        const currentZoom = this.mapInstance.getZoom();
        this.mapInstance.flyTo({
          center: [stockist.lng, stockist.lat],
          zoom: Math.max(currentZoom, 14),
          duration: 500,
        });
      }
    }
  }

  /**
   * Geocode an address query
   * @param {string} query
   * @returns {Promise<object[]>} Geocoding results
   */
  async #geocodeAddress(query) {
    // Cancel previous request
    this.searchController?.abort();
    this.searchController = new AbortController();

    try {
      const params = new URLSearchParams({
        q: query,
        format: 'json',
        limit: 5,
        addressdetails: 1,
      });

      const response = await fetch(`${this.config.geocodeUrl}?${params}`, {
        headers: { 'User-Agent': 'StockistLocator/1.0' },
        signal: this.searchController.signal,
      });

      if (!response.ok) throw new Error('Geocoding failed');

      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') return [];
      console.error('Geocoding error:', error);
      return [];
    }
  }

  /**
   * Show loading skeletons
   */
  #showLoadingSkeletons() {
    const skeletons = Array(3)
      .fill(null)
      .map(
        () => `
        <div class="stockist-locator__skeleton">
          <div class="stockist-locator__skeleton-line stockist-locator__skeleton-line--short"></div>
          <div class="stockist-locator__skeleton-line stockist-locator__skeleton-line--medium"></div>
          <div class="stockist-locator__skeleton-line"></div>
        </div>
      `
      )
      .join('');
    this.refs.list.innerHTML = skeletons;
  }

  /**
   * Show error message
   * @param {string} message
   */
  #showError(message) {
    const errorHtml = `
      <div class="stockist-locator__error" role="alert">
        <span class="stockist-locator__error-message">${escapeHTML(message)}</span>
        <button class="stockist-locator__error-dismiss" aria-label="Dismiss error" on:click="/handleDismissError">×</button>
      </div>
    `;

    const existingError = this.refs.list.querySelector('.stockist-locator__error');
    if (existingError) {
      existingError.remove();
    }
    this.refs.list.insertAdjacentHTML('afterbegin', errorHtml);
  }

  /**
   * Show autocomplete results
   * @param {object[]} results
   */
  #showAutocomplete(results) {
    if (results.length === 0) {
      this.#hideAutocomplete();
      return;
    }

    const html = results
      .map(
        (result, index) => `
        <li
          class="stockist-locator__autocomplete-item"
          data-index="${index}"
          data-lat="${result.lat}"
          data-lng="${result.lon}"
          on:click="/handleAutocompleteClick"
        >
          ${escapeHTML(result.display_name)}
        </li>
      `
      )
      .join('');

    this.refs.autocomplete.innerHTML = html;
    this.refs.autocomplete.classList.add('stockist-locator__autocomplete--active');
    this.refs.input.setAttribute('aria-expanded', 'true');
    this.highlightedIndex = -1;
  }

  /**
   * Hide autocomplete
   */
  #hideAutocomplete() {
    this.refs.autocomplete.classList.remove('stockist-locator__autocomplete--active');
    this.refs.autocomplete.innerHTML = '';
    this.refs.input.setAttribute('aria-expanded', 'false');
    this.highlightedIndex = -1;
  }

  /**
   * Navigate autocomplete with keyboard
   * @param {number} direction - 1 for down, -1 for up
   */
  #navigateAutocomplete(direction) {
    const items = this.refs.autocomplete.querySelectorAll('.stockist-locator__autocomplete-item');
    if (items.length === 0) return;

    if (this.highlightedIndex >= 0 && items[this.highlightedIndex]) {
      items[this.highlightedIndex].classList.remove('stockist-locator__autocomplete-item--highlighted');
    }

    this.highlightedIndex += direction;
    if (this.highlightedIndex < 0) this.highlightedIndex = items.length - 1;
    if (this.highlightedIndex >= items.length) this.highlightedIndex = 0;

    items[this.highlightedIndex].classList.add('stockist-locator__autocomplete-item--highlighted');
    items[this.highlightedIndex].scrollIntoView({ block: 'nearest' });
  }

  /**
   * Handle autocomplete query
   * @param {string} query
   */
  async #handleAutocomplete(query) {
    if (query.length < this.config.minChars) {
      this.#hideAutocomplete();
      return;
    }

    const results = await this.#geocodeAddress(query);
    this.#showAutocomplete(results);
  }

  // ==========================================
  // PUBLIC EVENT HANDLERS (declarative binding)
  // ==========================================

  /**
   * Handle search button click
   */
  async handleSearch() {
    const query = this.refs.input.value.trim();
    if (!query) return;

    this.#hideAutocomplete();
    this.#showLoadingSkeletons();

    const results = await this.#geocodeAddress(query);

    if (results.length > 0) {
      const location = results[0];
      this.#setUserLocation(parseFloat(location.lat), parseFloat(location.lon));
    } else {
      this.#showError('No locations found for that address. Please try a different search.');
      this.#renderStockists();
    }
  }

  /**
   * Handle clear button click
   */
  handleClear() {
    this.refs.input.value = '';

    if (this.userMarker) {
      this.userMarker.remove();
      this.userMarker = null;
    }

    if (this.activePopup) {
      this.activePopup.remove();
      this.activePopup = null;
    }

    this.userLocation = null;
    this.distanceFilter = this.config.defaultDistance;

    const distanceSelect = this.querySelector('[ref="distanceFilter"]');
    if (distanceSelect) {
      distanceSelect.value = this.distanceFilter === null ? '' : this.distanceFilter;
    }

    this.#renderStockists();
    this.#updateMarkers();
    this.#fitMapToMarkers();
    this.#updateClearButton();
    this.selectedStockist = null;
    this.#updateURL();
    this.refs.input.focus();
  }

  /**
   * Handle geolocation button click
   */
  async handleGeolocation() {
    if (!navigator.geolocation) {
      this.#showError('Geolocation is not supported by your browser.');
      return;
    }

    const btn = this.refs.geolocationBtn;
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Locating...';

    try {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 300000,
        });
      });

      const { latitude, longitude } = position.coords;
      this.refs.input.value = 'Current location';
      this.#setUserLocation(latitude, longitude);
    } catch (error) {
      let message = 'Unable to get your location. Please try entering an address instead.';
      if (error.code === error.PERMISSION_DENIED) {
        message = 'Location access was denied. Please enable location permissions or enter an address.';
      } else if (error.code === error.TIMEOUT) {
        message = 'Location request timed out. Please try again or enter an address.';
      }
      this.#showError(message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  }

  /**
   * Handle share button click
   */
  async handleShare() {
    const url = window.location.href;

    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Store Locations',
          text: 'Check out these store locations near me',
          url: url,
        });
        return;
      }

      await navigator.clipboard.writeText(url);

      const btn = this.refs.shareBtn;
      const originalHTML = btn.innerHTML;
      btn.classList.add('stockist-locator__action-btn--copied');
      btn.textContent = 'Link copied!';

      setTimeout(() => {
        btn.classList.remove('stockist-locator__action-btn--copied');
        btn.innerHTML = originalHTML;
      }, 2000);
    } catch (error) {
      this.#showError('Unable to share. Try copying the URL from your browser.');
    }
  }

  /**
   * Handle distance filter change
   * @param {Event} event
   */
  handleDistanceFilterChange(event) {
    const value = event.target.value;
    this.distanceFilter = value === '' ? null : parseFloat(value);
    this.#renderStockists();
    this.#updateMarkers();

    if (this.stockists.length === 0 && this.userLocation && this.distanceFilter !== null) {
      this.#showError(`No stores found within ${this.distanceFilter} miles. Try increasing the distance.`);
    }

    this.#updateURL();
  }

  /**
   * Handle input keydown for autocomplete navigation
   * @param {KeyboardEvent} event
   */
  handleInputKeydown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (this.highlightedIndex >= 0) {
        const items = this.refs.autocomplete.querySelectorAll('.stockist-locator__autocomplete-item');
        if (items[this.highlightedIndex]) {
          const item = items[this.highlightedIndex];
          const lat = parseFloat(item.dataset.lat);
          const lng = parseFloat(item.dataset.lng);
          this.refs.input.value = item.textContent.trim();
          this.#hideAutocomplete();
          this.#setUserLocation(lat, lng);
        }
      } else {
        this.handleSearch();
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.#navigateAutocomplete(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Escape') {
      this.#hideAutocomplete();
    }
  }

  /**
   * Handle input change for autocomplete
   * @param {Event} event
   */
  handleInputChange(event) {
    this.debouncedAutocomplete(event.target.value.trim());
    this.#updateClearButton();
  }

  /**
   * Handle autocomplete item click
   * @param {Event} event
   */
  handleAutocompleteClick(event) {
    const item = event.target.closest('.stockist-locator__autocomplete-item');
    if (item) {
      const lat = parseFloat(item.dataset.lat);
      const lng = parseFloat(item.dataset.lng);
      this.refs.input.value = item.textContent.trim();
      this.#hideAutocomplete();
      this.#setUserLocation(lat, lng);
    }
  }

  /**
   * Handle stockist item click
   * @param {Event} event
   */
  handleStockistClick(event) {
    // Don't handle if clicking a link
    if (event.target.closest('a')) return;

    const item = event.target.closest('.stockist-locator__item');
    if (item) {
      const id = parseInt(item.dataset.id, 10);
      this.#selectStockist(id);
    }
  }

  /**
   * Handle stockist item keydown
   * @param {KeyboardEvent} event
   */
  handleStockistKeydown(event) {
    if (event.key === 'Enter' || event.key === ' ') {
      // Don't handle if on a link
      if (event.target.closest('a')) return;

      event.preventDefault();
      const item = event.target.closest('.stockist-locator__item');
      if (item) {
        const id = parseInt(item.dataset.id, 10);
        this.#selectStockist(id);
      }
    }
  }

  /**
   * Handle dismiss error click
   */
  handleDismissError() {
    const error = this.refs.list.querySelector('.stockist-locator__error');
    if (error) error.remove();
  }

  /**
   * Handle click outside autocomplete
   * @param {Event} event
   */
  handleDocumentClick(event) {
    if (!this.refs.input.contains(event.target) && !this.refs.autocomplete.contains(event.target)) {
      this.#hideAutocomplete();
    }
  }
}

// Register the custom element
if (!customElements.get('stockist-locator')) {
  customElements.define('stockist-locator', StockistLocatorComponent);
}
