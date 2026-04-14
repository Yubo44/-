const CITIES = require("./cities");

const STORAGE_KEY = "dream-journey-records-v1";
const DEFAULT_GLOBE_ROTATION = 110;
const GLOBE_TILT = 14;
const GLOBE_RADIUS_PERCENT = 41.5;
const AUTO_ROTATE_STEP = 0.32;
const AUTO_ROTATE_INTERVAL = 60;

const CITY_INDEX = CITIES.reduce((accumulator, city) => {
  accumulator[city.id] = {
    ...city,
    searchText: [
      city.id,
      city.name,
      city.zh,
      city.country,
      city.countryZh,
    ].join(" ").toLowerCase(),
  };
  return accumulator;
}, {});

function createRecordId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeText(value) {
  return (value || "").trim();
}

function normalizeKeyword(value) {
  return normalizeText(value).replace(/\s+/g, " ").toLowerCase();
}

function normalizeRotation(value) {
  let normalized = value % 360;
  if (normalized < 0) {
    normalized += 360;
  }
  return Number(normalized.toFixed(2));
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function formatDate(timestamp) {
  const date = new Date(timestamp || Date.now());
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}.${month}.${day}`;
}

function buildPinKey(record) {
  if (record.cityId) {
    return record.cityId;
  }

  return `custom:${record.cityLabel || record.cityName || record.id}`;
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function buildTextureOffset(rotation) {
  return Number(((normalizeRotation(rotation) / 360) * 50).toFixed(3));
}

function projectGlobePoint(lat, lng, rotation) {
  const phi = toRadians(lat);
  const lambda = toRadians(lng);
  const lambda0 = toRadians(rotation);
  const phi0 = toRadians(GLOBE_TILT);
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const cosDelta = Math.cos(lambda - lambda0);
  const sinDelta = Math.sin(lambda - lambda0);
  const x = cosPhi * sinDelta;
  const y = Math.cos(phi0) * sinPhi - Math.sin(phi0) * cosPhi * cosDelta;
  const z = Math.sin(phi0) * sinPhi + Math.cos(phi0) * cosPhi * cosDelta;
  const depth = Math.max(z, 0);

  return {
    visible: z > 0.04,
    left: Number((50 + x * GLOBE_RADIUS_PERCENT).toFixed(2)),
    top: Number((50 - y * GLOBE_RADIUS_PERCENT).toFixed(2)),
    scale: Number((0.74 + depth * 0.4).toFixed(2)),
    opacity: Number((0.34 + depth * 0.66).toFixed(2)),
    zIndex: Math.round(100 + depth * 120),
  };
}

function decorateRecord(record) {
  const hasCoords =
    typeof record.lat === "number" &&
    !Number.isNaN(record.lat) &&
    typeof record.lng === "number" &&
    !Number.isNaN(record.lng);

  return {
    ...record,
    pinKey: buildPinKey(record),
    hasCoords,
    dateLabel: formatDate(record.createdAt),
    statusText: record.status === "visited" ? "去过" : "想去",
    previewText:
      record.status === "visited"
        ? record.noteText || "这次旅程还没写下回忆。"
        : record.planText || "这个目的地正在等你出发。",
  };
}

function buildSearchResult(city) {
  return {
    id: city.id,
    name: city.name,
    zh: city.zh,
    label: `${city.zh} ${city.name}`,
    countryLabel: `${city.countryZh} ${city.country}`,
    lat: city.lat,
    lng: city.lng,
  };
}

Page({
  data: {
    globeRotation: DEFAULT_GLOBE_ROTATION,
    globeTextureOffset: buildTextureOffset(DEFAULT_GLOBE_ROTATION),
    isDragging: false,
    searchKeyword: "",
    filteredCities: [],
    selectedCityId: "",
    selectedCityLabel: "",
    selectedCountryLabel: "",
    hasVisited: true,
    noteText: "",
    planText: "",
    draftPhotos: [],
    travelRecords: [],
    visibleRecords: [],
    globePins: [],
    listFilter: "all",
    visitedCount: 0,
    plannedCount: 0,
    totalCount: 0,
    activePinId: "",
  },

  onLoad() {
    this.dragStartX = 0;
    this.dragStartRotation = DEFAULT_GLOBE_ROTATION;
    this.globeAnchors = [];
    this.autoRotateTimer = null;
    this.syncRecords(this.loadStoredRecords(), false, {
      globeRotation: DEFAULT_GLOBE_ROTATION,
    });
    this.startAutoRotate();
  },

  onShow() {
    this.startAutoRotate();
  },

  onHide() {
    this.stopAutoRotate();
  },

  onUnload() {
    this.stopAutoRotate();
  },

  loadStoredRecords() {
    try {
      const stored = wx.getStorageSync(STORAGE_KEY);
      if (!Array.isArray(stored)) {
        return [];
      }
      return stored.map((record) => decorateRecord(record));
    } catch (error) {
      return [];
    }
  },

  persistRecords(records) {
    try {
      wx.setStorageSync(STORAGE_KEY, records);
    } catch (error) {
      wx.showToast({
        title: "本地保存失败",
        icon: "none",
      });
    }
  },

  startAutoRotate() {
    if (this.autoRotateTimer) {
      return;
    }

    this.autoRotateTimer = setInterval(() => {
      if (this.data.isDragging) {
        return;
      }

      this.refreshGlobe(this.data.globeRotation + AUTO_ROTATE_STEP);
    }, AUTO_ROTATE_INTERVAL);
  },

  stopAutoRotate() {
    if (!this.autoRotateTimer) {
      return;
    }

    clearInterval(this.autoRotateTimer);
    this.autoRotateTimer = null;
  },

  buildVisibleRecords(records, listFilter) {
    if (listFilter === "all") {
      return records;
    }

    return records.filter((record) => record.status === listFilter);
  },

  buildGlobeAnchors(records) {
    const uniquePins = {};

    records.forEach((record) => {
      if (!record.hasCoords) {
        return;
      }

      const current = uniquePins[record.pinKey];
      if (!current || (current.status !== "visited" && record.status === "visited")) {
        uniquePins[record.pinKey] = {
          pinKey: record.pinKey,
          cityLabel: record.cityLabel,
          countryLabel: record.countryLabel,
          status: record.status,
          lat: record.lat,
          lng: record.lng,
        };
      }
    });

    return Object.values(uniquePins);
  },

  buildGlobePins(anchors, rotation, activePinId) {
    return (anchors || [])
      .map((anchor) => {
        const projection = projectGlobePoint(anchor.lat, anchor.lng, rotation);
        if (!projection.visible) {
          return null;
        }

        const isActive = anchor.pinKey === activePinId;

        return {
          ...anchor,
          ...projection,
          zIndex: projection.zIndex + (isActive ? 300 : 0),
        };
      })
      .filter(Boolean)
      .sort((first, second) => first.zIndex - second.zIndex);
  },

  syncRecords(records, shouldPersist = false, extraData = {}) {
    const normalizedRecords = (records || [])
      .map((record) => decorateRecord(record))
      .sort((first, second) => second.createdAt - first.createdAt);
    const nextRotation = hasOwn(extraData, "globeRotation")
      ? normalizeRotation(extraData.globeRotation)
      : this.data.globeRotation;
    const nextActivePinId = hasOwn(extraData, "activePinId")
      ? extraData.activePinId
      : this.data.activePinId;
    const visibleRecords = this.buildVisibleRecords(normalizedRecords, this.data.listFilter);
    const globeAnchors = this.buildGlobeAnchors(normalizedRecords);
    const globePins = this.buildGlobePins(globeAnchors, nextRotation, nextActivePinId);

    this.globeAnchors = globeAnchors;

    this.setData({
      travelRecords: normalizedRecords,
      visibleRecords,
      globePins,
      globeRotation: nextRotation,
      globeTextureOffset: buildTextureOffset(nextRotation),
      activePinId: nextActivePinId,
      visitedCount: normalizedRecords.filter((record) => record.status === "visited").length,
      plannedCount: normalizedRecords.filter((record) => record.status === "planned").length,
      totalCount: normalizedRecords.length,
    });

    if (shouldPersist) {
      this.persistRecords(normalizedRecords);
    }
  },

  refreshGlobe(rotation = this.data.globeRotation, activePinId = this.data.activePinId) {
    const nextRotation = normalizeRotation(rotation);
    const globePins = this.buildGlobePins(this.globeAnchors, nextRotation, activePinId);

    this.setData({
      globeRotation: nextRotation,
      globeTextureOffset: buildTextureOffset(nextRotation),
      globePins,
      activePinId,
    });
  },

  updateSearchResults(value) {
    const keyword = normalizeKeyword(value);
    if (!keyword) {
      this.setData({
        filteredCities: [],
        selectedCityId: "",
        selectedCityLabel: "",
        selectedCountryLabel: "",
      });
      return;
    }

    const filteredCities = CITIES
      .map((city) => CITY_INDEX[city.id])
      .filter((city) => city.searchText.indexOf(keyword) !== -1)
      .slice(0, 8)
      .map((city) => buildSearchResult(city));

    this.setData({
      filteredCities,
      selectedCityId: "",
      selectedCityLabel: "",
      selectedCountryLabel: "",
    });
  },

  onSearchInput(event) {
    const value = event.detail.value || "";
    this.setData({
      searchKeyword: value,
    });
    this.updateSearchResults(value);
  },

  selectCity(event) {
    const city = CITY_INDEX[event.currentTarget.dataset.cityId];
    if (!city) {
      return;
    }

    this.setData({
      searchKeyword: `${city.zh} ${city.name}`,
      filteredCities: [],
      selectedCityId: city.id,
      selectedCityLabel: `${city.zh} ${city.name}`,
      selectedCountryLabel: `${city.countryZh} ${city.country}`,
    });
    this.refreshGlobe(city.lng, city.id);
  },

  resolveSelectedCity() {
    const keyword = normalizeText(this.data.searchKeyword);
    if (!keyword) {
      return null;
    }

    if (this.data.selectedCityId && CITY_INDEX[this.data.selectedCityId]) {
      return CITY_INDEX[this.data.selectedCityId];
    }

    const normalizedKeyword = normalizeKeyword(keyword);
    const matchedCity = CITIES
      .map((city) => CITY_INDEX[city.id])
      .find((city) => {
        const exactLabels = [
          city.id,
          city.name,
          city.zh,
          `${city.zh} ${city.name}`,
          `${city.name} ${city.country}`,
          `${city.zh} ${city.name} ${city.countryZh}`,
        ].map((label) => normalizeKeyword(label));

        return exactLabels.indexOf(normalizedKeyword) !== -1;
      });

    return matchedCity || null;
  },

  markVisited() {
    this.setData({
      hasVisited: true,
    });
  },

  markPlanned() {
    this.setData({
      hasVisited: false,
    });
  },

  onNoteInput(event) {
    this.setData({
      noteText: event.detail.value || "",
    });
  },

  onPlanInput(event) {
    this.setData({
      planText: event.detail.value || "",
    });
  },

  choosePhotos() {
    const remainingCount = 6 - this.data.draftPhotos.length;
    if (remainingCount <= 0) {
      wx.showToast({
        title: "最多添加 6 张照片",
        icon: "none",
      });
      return;
    }

    wx.chooseImage({
      count: remainingCount,
      sizeType: ["compressed"],
      sourceType: ["album", "camera"],
      success: (response) => {
        const tempFilePaths = response.tempFilePaths || [];
        const saveTasks = tempFilePaths.map((tempFilePath) => this.persistPhoto(tempFilePath));

        Promise.all(saveTasks).then((savedPhotos) => {
          this.setData({
            draftPhotos: this.data.draftPhotos.concat(savedPhotos).slice(0, 6),
          });
        });
      },
    });
  },

  // Save picked images when possible so they survive a cold start in DevTools.
  persistPhoto(tempFilePath) {
    return new Promise((resolve) => {
      wx.saveFile({
        tempFilePath,
        success: ({ savedFilePath }) => resolve(savedFilePath || tempFilePath),
        fail: () => resolve(tempFilePath),
      });
    });
  },

  removeDraftPhoto(event) {
    const photoIndex = Number(event.currentTarget.dataset.index);
    this.setData({
      draftPhotos: this.data.draftPhotos.filter((_, index) => index !== photoIndex),
    });
  },

  previewDraftPhoto(event) {
    const current = event.currentTarget.dataset.url;
    wx.previewImage({
      current,
      urls: this.data.draftPhotos,
    });
  },

  saveRecord() {
    const rawKeyword = normalizeText(this.data.searchKeyword);
    const noteText = normalizeText(this.data.noteText);
    const planText = normalizeText(this.data.planText);
    const selectedCity = this.resolveSelectedCity();
    const isVisited = this.data.hasVisited;

    if (!rawKeyword) {
      wx.showToast({
        title: "先搜索或输入一个城市",
        icon: "none",
      });
      return;
    }

    if (isVisited && !noteText && !this.data.draftPhotos.length) {
      wx.showToast({
        title: "去过的城市至少写点回忆或添加照片",
        icon: "none",
      });
      return;
    }

    if (!isVisited && !planText) {
      wx.showToast({
        title: "写一点旅行计划再保存",
        icon: "none",
      });
      return;
    }

    const record = decorateRecord({
      id: createRecordId(),
      cityId: selectedCity ? selectedCity.id : "",
      cityName: selectedCity ? selectedCity.name : rawKeyword,
      cityLabel: selectedCity ? `${selectedCity.zh} ${selectedCity.name}` : rawKeyword,
      countryLabel: selectedCity
        ? `${selectedCity.countryZh} ${selectedCity.country}`
        : "自定义地点",
      status: isVisited ? "visited" : "planned",
      noteText: isVisited ? noteText : "",
      planText: isVisited ? "" : planText,
      photos: isVisited ? this.data.draftPhotos.slice(0, 6) : [],
      lat: selectedCity ? selectedCity.lat : null,
      lng: selectedCity ? selectedCity.lng : null,
      createdAt: Date.now(),
    });
    const nextState = {
      activePinId: record.pinKey,
    };

    if (selectedCity) {
      nextState.globeRotation = selectedCity.lng;
    }

    this.syncRecords([record].concat(this.data.travelRecords), true, nextState);
    this.resetForm();

    wx.showToast({
      title: isVisited ? "旅行记忆已点亮" : "旅行计划已加入",
      icon: "success",
    });
  },

  resetForm() {
    this.setData({
      searchKeyword: "",
      filteredCities: [],
      selectedCityId: "",
      selectedCityLabel: "",
      selectedCountryLabel: "",
      hasVisited: true,
      noteText: "",
      planText: "",
      draftPhotos: [],
    });
  },

  clearDraft() {
    this.resetForm();
  },

  changeFilter(event) {
    const listFilter = event.currentTarget.dataset.filter;
    this.setData({
      listFilter,
      visibleRecords: this.buildVisibleRecords(this.data.travelRecords, listFilter),
    });
  },

  activateRecord(event) {
    const record = this.data.travelRecords.find(
      (item) => item.id === event.currentTarget.dataset.id
    );

    if (!record) {
      return;
    }

    if (record.hasCoords) {
      this.refreshGlobe(record.lng, record.pinKey);
      return;
    }

    this.refreshGlobe(this.data.globeRotation, record.pinKey);
  },

  removeRecord(event) {
    const recordId = event.currentTarget.dataset.id;
    const record = this.data.travelRecords.find((item) => item.id === recordId);

    if (!record) {
      return;
    }

    wx.showModal({
      title: "删除地点",
      content: `确定删除 ${record.cityLabel} 吗？`,
      success: ({ confirm }) => {
        if (!confirm) {
          return;
        }

        const remaining = this.data.travelRecords.filter((item) => item.id !== recordId);
        const nextActivePinId = this.data.activePinId === record.pinKey ? "" : this.data.activePinId;
        this.syncRecords(remaining, true, {
          activePinId: nextActivePinId,
        });
      },
    });
  },

  removeRecordPhoto(event) {
    const recordId = event.currentTarget.dataset.id;
    const photoIndex = Number(event.currentTarget.dataset.photoIndex);
    const updatedRecords = this.data.travelRecords.map((record) => {
      if (record.id !== recordId) {
        return record;
      }

      return decorateRecord({
        ...record,
        photos: record.photos.filter((_, index) => index !== photoIndex),
      });
    });

    this.syncRecords(updatedRecords, true);
  },

  previewRecordPhoto(event) {
    const record = this.data.travelRecords.find((item) => item.id === event.currentTarget.dataset.id);
    const current = event.currentTarget.dataset.url;

    if (!record) {
      return;
    }

    wx.previewImage({
      current,
      urls: record.photos,
    });
  },

  onPinTap(event) {
    const pin = this.data.globePins.find((item) => item.pinKey === event.currentTarget.dataset.pinKey);
    if (!pin) {
      return;
    }

    this.refreshGlobe(this.data.globeRotation, pin.pinKey);

    wx.showToast({
      title: `${pin.cityLabel} · ${pin.status === "visited" ? "去过" : "想去"}`,
      icon: "none",
    });
  },

  onMapTouchStart(event) {
    if (!event.touches || !event.touches.length) {
      return;
    }

    this.dragStartX = event.touches[0].clientX;
    this.dragStartRotation = this.data.globeRotation;
    this.setData({
      isDragging: true,
    });
  },

  onMapTouchMove(event) {
    if (!event.touches || !event.touches.length) {
      return;
    }

    const deltaX = event.touches[0].clientX - this.dragStartX;
    const nextRotation = this.dragStartRotation - deltaX * 0.48;
    this.refreshGlobe(nextRotation);
  },

  onMapTouchEnd() {
    this.setData({
      isDragging: false,
    });
  },

  resetMapRotation() {
    this.refreshGlobe(DEFAULT_GLOBE_ROTATION);
  },
});
