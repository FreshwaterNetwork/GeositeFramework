﻿/*jslint nomen:true, devel:true */
/*global Backbone, _, $, Geosite, esri, Azavea, setTimeout, dojo, dojox */

require(['use!Geosite',
         'framework/Legend',
         'framework/widgets/map_utils/main',
         'framework/util/ajax',
         'esri/config',
         'esri/Map',
         'esri/views/MapView',
         'esri/views/SceneView',
         'esri/Basemap',
         // Scalebar is not yet implemented in Esri JS API v4.2:
         // https://developers.arcgis.com/javascript/latest/guide/functionality-matrix/index.html#widgets
         // 'esri/dijit/Scalebar',
         'esri/layers/TileLayer',
         'esri/geometry/Extent',
         'esri/geometry/SpatialReference',
         'esri/widgets/Search',
         'dojo/domReady!',
        ],
    function(N,
             Legend,
             MapUtils,
             ajaxUtil,
             esriConfig,
             Map,
             MapView,
             SceneView,
             Basemap,
             // Scalebar is not yet implemented in Esri JS API v4.2:
             // https://developers.arcgis.com/javascript/latest/guide/functionality-matrix/index.html#widgets
             // ScaleBar,
             TileLayer,
             Extent,
             SpatialReference,
             Search) {
    'use strict';

    function getSelectedBasemapLayer(model, esriMap) {
        // Return an ESRI Basemap object for the currently-selected basemap spec
        var basemap = getSelectedBasemap(model);
        if (basemap.layer === undefined) {
            if (basemap.url.substring(0,4) === 'http') {
                basemap.layer = new Basemap({
                    baseLayers: [new TileLayer(basemap.url)],
                    id: basemap.name,
                    title: basemap.name
                });
            } else {
                // It's valid to also specify a short code for a well known basemap
                basemap.layer = basemap.url;
            }
        }
        return basemap.layer;
    }

    function getSelectedBasemap(model) {
        // Return the selected basemap spec, after validation
        var basemaps = model.get('basemaps'),
        selectedBasemapIndex = model.get('selectedBasemapIndex'),
        valid = basemaps !== null &&
                selectedBasemapIndex !== null &&
                selectedBasemapIndex < basemaps.length;
        if (valid) {
            return basemaps[selectedBasemapIndex];
        } else {
            Azavea.logError("Internal error in basemap selector: no basemaps defined or invalid basemap index");
            return { name: "", url: "" };
        }
    }

    N.models = N.models || {};
    N.models.Map = Backbone.Model.extend({
        defaults: {
            mapNumber: null,
            basemaps: null,
            selectedBasemapIndex: 0,   // Both the map view and the basemap selector listen for changes to this attribute
            sync: false,
            is2dMode: true
        },

        initialize: function () {
            // deep-copy 'basemaps' because we're going to modify its elements by adding 'layer' properties
            this.set('basemaps', $.extend(true, [], this.get('basemaps')));

            // Use map model in permalinks
            N.app.hashModels.addModel(this, {
                id: 'map' + this.get('mapNumber'),
                attributes: ['extent', 'selectedBasemapIndex']
            });

            // Keep track of MapImageLayers added to the map
            this.serviceInfos = {};
        },

        getSelectedBasemapName: function () { return getSelectedBasemap(this).name; },
        getSelectedBasemapLayer: function (esriMap) { return getSelectedBasemapLayer(this, esriMap); },

        addService: function (service, plugin) {
            this.serviceInfos[service.id] = {
                service: service,
                pluginObject: plugin
            };
        },

        removeService: function (service) {
            delete this.serviceInfos[service.id];
        }
    });

    function setActiveEsriMapView(esriMap, activateView, deactivateView) {
        // I tried removeing and re-adding the map propery on each view so
        // that renders are not computed when they are not active, which works,
        // but the views throw errors after it's re-attached, despite no apparent
        // loss in functionality.  It doesn't appear to render when the mount
        // container is display:none;
        activateView.extent = deactivateView.extent;
        activateView.zoom = deactivateView.zoom;
        $(activateView.container).show();
        $(deactivateView.container).hide();
    }

    function initialize(view) {
        view.model.on('change:selectedBasemapIndex', function () { selectBasemap(view); });
        view.model.on('change:extent', function () {
            var currentExtent = view.model.get('extent');

            if (!_.isEqual(currentExtent, view.esriMapView.extent)) {
                loadExtent(view);
            }
        });
        view.model.on('change:is2dMode', function() {
            if (view.model.get('is2dMode')) {
                setActiveEsriMapView(view.esriMap, view.esriMapView, view.esriSceneView);
            } else {
                setActiveEsriMapView(view.esriMap, view.esriSceneView, view.esriMapView);
            }
        });


        // Configure the esri proxy, for (at least) 2 cases:
        // 1) For WMS "GetCapabilities" requests
        // 2) When it needs to make an HTTP GET with a URL longer than 2000 chars
        esriConfig.request.proxyUrl = "proxy.ashx";
        createMap(view);
    }

    function createMap(view) {

        // Reworking this because the Esri JS API 4.2
        // expects a `map` and a `MapView` with separate concerns.
        // Leaving the original code here for reference, but I think
        // some of this should be set to work on a MapView:
        // See https://developers.arcgis.com/javascript/latest/api-reference/esri-views-MapView.html
        /*
        var esriMap = Map(view.$el.attr('id'), {
                sliderPosition: 'top-right'
            }),
            resizeMap = _.debounce(function () {
                // When the element containing the map resizes, the
                // map needs to be notified.  Do a slight delay so that
                // the browser has time to actually make the element visible.
                    if (view.$el.is(':visible')) {
                        var center = esriMap.extent.getCenter();
                        esriMap.reposition();
                        esriMap.resize(true);
                        esriMap.centerAt(center);
                    }
            }, 300),
            loadEventFired = false;
        */
        // This `Map` object's initialized without a basemap; it will be set
        // from `region.json` in `selectBasemap(view)` below
        var esriMap = new Map();
        var esriMapView = new MapView({
            map: esriMap,
            container: 'esri-mapview-mount'
        });
        var esriSceneView = new SceneView({
            map: esriMap,
            container: 'esri-sceneview-mount'
        });

        view.esriMap = esriMap;
        view.esriMapView = esriMapView;
        view.esriSceneView = esriSceneView;
        loadExtent(view);
        selectBasemap(view);
        initSearch(view);

        // Scalebar is not yet implemented in Esri JS API 4.2:
        // https://developers.arcgis.com/javascript/latest/guide/functionality-matrix/index.html#widgets
        /*
        var scalebar = new ScaleBar({
            map: view.esriMap,
            scalebarUnit: 'dual'
        });
        */

        var throttledSet = _.debounce(function() { view.model.set('extent', view.esriMap.extent) }, 1000);
        dojo.connect(view.esriMap, 'onExtentChange', function(newExtent) {
            var currentExtent = view.model.get('extent');

            if (!_.isEqual(currentExtent, newExtent)) {
                throttledSet();
            }
        });

        // Wait for the map to load
        dojo.connect(esriMap, "onLoad", function () {
            loadEventFired = true;
            resizeMap();
            $(N).on('resize', resizeMap);

            // Add this map to the list of maps to sync when in sync mode
            N.app.syncedMapManager.addMapView(view);

            initLegend(view, esriMap);
            initMapUtils(view, esriMap);

            // Cache the parent of the infowindow rather than re-select it every time.
            // Occasionally, the infoWindow dom node as accessed from the underlaying esri.map
            // would be detached from the body and the parent would not be accessible
            view.$infoWindowParent = $(esriMap.infoWindow.domNode).parent();

            setupSubregions(N.app.data.region.subregions, esriMap);
        });

        function setupSubregions(subregions, esriMap) {
            // Subregions are not required
            if (!subregions) return;

            var subRegionManager = new N.controllers.SubRegion(subregions, esriMap);

            subRegionManager.onActivated(function(subregion) {
                view.model.trigger('subregion-activate', subregion);
            });

            subRegionManager.onDeactivated(function(subregion) {
                view.model.trigger('subregion-deactivate', subregion);
            });
        }

        function initSearch(view) {
            // Add search control
            var search = new Search({
                view: view.esriMapView,
                showInfoWindowOnSelect: false,
                enableHighlight: false,
            }, "search");

            // The translation lookup isn't ready when this is initialized.
            // A slight delay is needed.
            window.setTimeout(function() {
                // Required to set the placeholder text.
                var sources = search.get("sources");
                sources[0].placeholder = i18next.t("Find address or place");
                search.set("sources", sources);
                search.startup();
            }, 200);
        }

        // TODO: Remove this once it's confirmed that it's not necessary for IE11.
        //
        // On IE8, the map.onload event will often not fire at all, which breaks
        // the app entirely.  The map does, in fact, load and its loaded property is
        // set.  I put in this hack to check up on the event a little while after
        // it was created and manually raise the event if the library didn't do it.
        /*
        setTimeout(function() {
            if (!loadEventFired) {
                if (esriMap.loaded) esriMap.onLoad(esriMap);
            }
        }, 2500);
        */
    }

    function loadExtent(view) {
        var x = view.model.get('extent'),
            extent = Extent(
                x.xmin, x.ymin, x.xmax, x.ymax,
                new SpatialReference({ wkid: x.spatialReference.wkid })
            );
        view.esriMapView.extent = extent;
    }

    function saveExtent(view) {
        view.model.set('extent', view.esriMapView.extent);
    }

    function selectBasemap(view) {
        // Instead of using `.show` and `.hide` methods, the Esri ArcGIS JS API 4.2
        // uses direct setters. Here we set the basemap from the TileLayer created
        // and cached in the `.getSelectedBasemapLayer` method
        view.esriMap.basemap = view.model.getSelectedBasemapLayer(view.esriMap);
    }

    function initLegend(view, esriMap) {
        var mapNumber =  view.model.get('mapNumber'),
            regionData = N.app.data.region,
            id = 'legend-container-' + mapNumber,
            legend = new Legend(regionData, id);

        var redraw = function() {
            legend.render(getVisibleLayers());
        };

        function getServiceLegend(service) {
            var legendUrl = service.url + '/legend',
                data = ajaxUtil.get(legendUrl);
            if (ajaxUtil.shouldFetch(legendUrl)) {
                ajaxUtil.fetch(legendUrl).then(redraw);
            }
            return data && data.layers;
        }

        function getVisibleLayers() {
            var services = esriMap.getLayersVisibleAtScale(esriMap.getScale()),
                result = [];
            _.each(services, function (service) {
                var serviceInfo = view.model.serviceInfos[service.id];
                if (serviceInfo && service.visible && serviceInfo.pluginObject.showServiceLayersInLegend) {
                    service.visibleLayers.sort(function(a, b) { return a - b; });
                    _.each(service.visibleLayers, function(layerId) {
                        var layer,
                            legend,
                            layerId = parseInt(layerId);

                        if (isWms(service)) {
                            layer = _getWMSLayer(service, layerId);
                            if (!layer) { return; }
                            legend = _getWMSLegend(layer);
                        } else {
                            layer = _getAGSLayer(service, layerId);
                            if (!layer) { return; }
                            legend = _getAGSLegend(service, layerId);
                        }

                        if (isLayerInScale(service, layer)) {
                            result.push({
                                service: service,
                                layer: layer,
                                legend: legend
                            });
                        }
                    });
                }

            });
            return result;
        }

        function isWms(service) {
            if (service.description && service.description.match(/WMS/i)) {
                return true;
            }
            return false;
        }

        function _getWMSLayer(service, layerId) {
            return _.findWhere(service.layerInfos, {name: layerId});
        }

        function _getWMSLegend(layer) {
            return layer.legendURL;
        }

        function _getAGSLayer(service, layerId) {
            return _.findWhere(service.layerInfos, {id: layerId});
        }

        function _getAGSLegend(service, layerId) {
            var serviceLegend = getServiceLegend(service);

            if (!serviceLegend) {
                return;
            }

            return _.findWhere(serviceLegend, {layerId: layerId});
        }

        // Filter out layers that are not visible at the current map scale.
        // Adapted from the ESRI dijit legend source code. (Ref: _isLayerInScale)
        function isLayerInScale(service, layer) {
            var scale = esriMap.getScale();
            var minScale = Math.min(service.minScale, layer.minScale) || service.minScale || layer.minScale || 0;
            var maxScale = Math.max(service.maxScale, layer.maxScale) || 0;
            return minScale === 0 || minScale > scale && maxScale < scale;
        }

        dojo.connect(esriMap, 'onUpdateEnd', redraw);
        dojo.connect(esriMap, 'onLayerAdd', redraw);
        dojo.connect(esriMap, 'onLayerRemove', redraw);
        dojo.connect(esriMap, 'onLayerSuspend', redraw);
        // TODO: Update this for the Esri JS API v4.2,
        // which splits the Map into a Map and a MapView
        // See https://developers.arcgis.com/javascript/latest/api-reference/esri-views-MapView.html
        // Allow plugins to trigger a legend redraw by calling map.resize()
        // dojo.connect(esriMap, 'resize', redraw);
    }

    function initMapUtils(view, esriMap) {
        var el = $('#map-utils-control').get(0);
        return new MapUtils({
            el: el,
            map: esriMap,
            app: N.app,
            regionData: N.app.data.region
        });
    }

    N.views = N.views || {};
    N.views.Map = Backbone.View.extend({
        $infoWindowParent: null,
        initialize: function () { initialize(this); },
        doIdentify: function (pluginModels, event) { N.doIdentify(this, pluginModels, event); },
        saveState: function () { saveExtent(this); }
    });
});
