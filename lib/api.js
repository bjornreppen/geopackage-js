/**
 * GeoPackage module.
 * @module GeoPackage
 */

var wkx = require('wkx')
  , reproject = require('reproject')
  , path = require('path')
  , async = require('async')
  , fs = require('fs');

var GeoPackage = require('./geoPackage')
  , GeoPackageValidate = require('./validate/geoPackageValidate')
  , GeoPackageTileRetriever = require('./tiles/retriever')
  , GeoPackageConnection = require('./db/geoPackageConnection')
  , BoundingBox = require('./boundingBox')
  , GeometryData = require('./geom/geometryData')
  , TableCreator = require('./db/tableCreator')
  , TileBoundingBoxUtils = require('./tiles/tileBoundingBoxUtils')
  , FeatureTile = require('./tiles/features')
  , FeatureTableIndex = require('./extension/index/featureTableIndex');

function GeoPackageAPI() {
}

module.exports = GeoPackageAPI;

/**
 * Open a GeoPackage at the path specified
 * @param  {String}   gppathOrByteArray   path where the GeoPackage exists or Uint8Array of GeoPackage bytes
 * @param  {Function} callback optional called with an error and the GeoPackage object if opened
 * @return {Promise} promise that will resolve with the open geoPackage object
 */
GeoPackageAPI.open = function(gppathOrByteArray, callback) {
  return new Promise(function(resolve, reject) {
    var valid = (typeof gppathOrByteArray !== 'string') || (typeof gppathOrByteArray === 'string' && !GeoPackageValidate.validateGeoPackageExtension(gppathOrByteArray));

    if (!valid) {
      reject(new Error('Invalid GeoPackage - Invalid GeoPackage Extension'));
    } else {
      resolve(gppathOrByteArray);
    }
  }).then(function() {
    return GeoPackageConnection.connect(gppathOrByteArray);
  }).then(function(connection) {
    if (gppathOrByteArray && typeof gppathOrByteArray === 'string') {
      return new GeoPackage(path.basename(gppathOrByteArray), gppathOrByteArray, connection);
    } else {
      return new GeoPackage('geopackage', undefined, connection);
    }
  })
  .then(function(geoPackage) {
    if (GeoPackageValidate.hasMinimumTables(geoPackage)) {
      return geoPackage;
    } else {
      throw new Error('Invalid GeoPackage - GeoPackage does not have the minimum required tables');
    }
  })
  .then(function(geoPackage) {
    if(callback) callback(null, geoPackage);
    return geoPackage;
  })
  .catch(function(error){
    if(callback) {
      callback(error);
    } else {
      return error;
    }
  });
};

/**
 * Creates a GeoPackage file at the path specified in node or opens an in memory GeoPackage on the browser
 * @param  {String}   gppath   path to GeoPackage fileType
 * @param  {Function} callback called with an error if one occurred and the open GeoPackage object
 * @return {Promise} promise that will resolve with the open geoPackage object
 */
GeoPackageAPI.create = function(gppath, callback) {
  if (typeof gppath == 'function') {
    callback = gppath;
    gppath = undefined;
  }
  var valid = (typeof gppath !== 'string') || (typeof gppath === 'string' && !GeoPackageValidate.validateGeoPackageExtension(gppath));
  if (!valid) {
    if (callback) {
      return callback(new Error('Invalid GeoPackage'));
    }
    return Promise.reject(new Error('Invalid GeoPackage'));
  }

  var promise = new Promise(function(resolve, reject) {
    if (typeof(process) !== 'undefined' && process.version && gppath) {
      fs.mkdirSync(path.dirname(gppath));
    }
    resolve(gppath);
  })
  .catch(function(error) {
    // could not create directory, just move on
  })
  .then(function() {
    return GeoPackageConnection.connect(gppath);
  })
  .then(function(connection) {
    connection.setApplicationId();
    return connection;
  })
  .then(function(connection) {
    if (gppath) {
      return new GeoPackage(path.basename(gppath), gppath, connection);
    } else {
      return new GeoPackage('geopackage', undefined, connection);
    }
  })
  .then(function(geopackage) {
    return geopackage.createRequiredTables();
  })
  .then(function(geopackage) {
    if(callback) callback(null, geopackage);
    return geopackage;
  })
  .catch(function(error){
    if(callback) {
      callback(error);
    } else {
      return error;
    }
  });

  return promise;
};

GeoPackageAPI.createStandardWebMercatorTileTable = function(geopackage, tableName, contentsBoundingBox, contentsSrsId, tileMatrixSetBoundingBox, tileMatrixSetSrsId, minZoom, maxZoom) {
  return geopackage.createTileTableWithTableName(tableName, contentsBoundingBox, contentsSrsId, tileMatrixSetBoundingBox, tileMatrixSetSrsId)
  .then(function(tileMatrixSet) {
    geopackage.createStandardWebMercatorTileMatrix(tileMatrixSetBoundingBox, tileMatrixSet, minZoom, maxZoom)
    return tileMatrixSet;
  });
}

GeoPackageAPI.createFeatureTable = function(geopackage, tableName, geometryColumn, featureColumns) {
  return GeoPackageAPI.createFeatureTableWithDataColumns(geopackage, tableName, geometryColumn, featureColumns, null);
};

GeoPackageAPI.createFeatureTableWithDataColumns = function(geopackage, tableName, geometryColumn, featureColumns, dataColumns) {
  var boundingBox = new BoundingBox(-180, 180, -90, 90);
  return GeoPackageAPI.createFeatureTableWithDataColumnsAndBoundingBox(geopackage, tableName, geometryColumn, featureColumns, dataColumns, boundingBox, 4326);
};

GeoPackageAPI.createFeatureTableWithDataColumnsAndBoundingBox = function(geopackage, tableName, geometryColumn, featureColumns, dataColumns, boundingBox, boundingBoxSrsId) {
  return geopackage.createFeatureTableWithGeometryColumnsAndDataColumns(geometryColumn, boundingBox, boundingBoxSrsId, featureColumns, dataColumns)
  .then(function() {
    return geopackage.getFeatureDaoWithTableName(tableName);
  });
};

/**
 * Adds a GeoJSON feature to the GeoPackage
 * @param  {GeoPackage}   geopackage open GeoPackage object
 * @param  {object}   feature    GeoJSON feature to add
 * @param  {String}   tableName  Table name to add the tile to
 */
GeoPackageAPI.addGeoJSONFeatureToGeoPackage = function(geopackage, feature, tableName) {
  return geopackage.getFeatureDaoWithTableName(tableName)
  .then(function(featureDao) {
    var srs = featureDao.getSrs();
    var featureRow = featureDao.newRow();
    var geometryData = new GeometryData();
    geometryData.setSrsId(srs.srs_id);
    var reprojectedFeature = reproject.reproject(feature, 'EPSG:4326', srs.organization + ':' + srs.organization_coordsys_id);

    var featureGeometry = typeof reprojectedFeature.geometry === 'string' ? JSON.parse(reprojectedFeature.geometry) : reprojectedFeature.geometry;
    var geometry = wkx.Geometry.parseGeoJSON(featureGeometry);
    geometryData.setGeometry(geometry);
    featureRow.setGeometry(geometryData);
    for (var propertyKey in feature.properties) {
      if (feature.properties.hasOwnProperty(propertyKey)) {
        featureRow.setValueWithColumnName(propertyKey, feature.properties[propertyKey]);
      }
    }

    return featureDao.create(featureRow);
  });
};

/**
 * Adds a GeoJSON feature to the GeoPackage and updates the FeatureTableIndex extension if it exists
 * @param  {GeoPackage}   geopackage open GeoPackage object
 * @param  {object}   feature    GeoJSON feature to add
 * @param  {String}   tableName  Table name to add the tile to
 */
GeoPackageAPI.addGeoJSONFeatureToGeoPackageAndIndex = function(geopackage, feature, tableName) {
  return geopackage.getFeatureDaoWithTableName(tableName)
  .then(function(featureDao) {
    if (!featureDao) throw new Error('No feature Dao for table ', + tableName);
    var srs = featureDao.getSrs();
    var featureRow = featureDao.newRow();
    var geometryData = new GeometryData();
    geometryData.setSrsId(srs.srs_id);

    var reprojectedFeature = reproject.reproject(feature, 'EPSG:4326', srs.organization + ':' + srs.organization_coordsys_id);

    var featureGeometry = typeof reprojectedFeature.geometry === 'string' ? JSON.parse(reprojectedFeature.geometry) : reprojectedFeature.geometry;
    var geometry = wkx.Geometry.parseGeoJSON(featureGeometry);
    geometryData.setGeometry(geometry);
    featureRow.setGeometry(geometryData);
    for (var propertyKey in feature.properties) {
      if (feature.properties.hasOwnProperty(propertyKey)) {
        featureRow.setValueWithColumnName(propertyKey, feature.properties[propertyKey]);
      }
    }

    var id = featureDao.create(featureRow);
    var fti = featureDao.featureTableIndex;
    var tableIndex = fti.getTableIndex();
    if (!tableIndex) return id;
    fti.indexRow(tableIndex, id, geometryData);
    fti.updateLastIndexed(tableIndex);
    return id;
  });
};

/**
 * Queries for GeoJSON features in a feature tables
 * @param  {String}   geoPackagePath  path to the GeoPackage file
 * @param  {String}   tableName   Table name to query
 * @param  {BoundingBox}   boundingBox BoundingBox to query
 * @param  {Function} callback    Caled with err, featureArray
 */
GeoPackageAPI.queryForGeoJSONFeaturesInTableFromPath = function(geoPackagePath, tableName, boundingBox) {
  return GeoPackageAPI.open(geoPackagePath)
  .then(function(geoPackage) {
    return geoPackage.queryForGeoJSONFeaturesInTable(tableName, boundingBox)
    .then(function(features) {
      geoPackage.close();
      return features;
    });
  })
  .then(function(features) {
    return features;
  });
}

/**
 * Queries for GeoJSON features in a feature tables
 * @param  {GeoPackage}   geoPackage  open GeoPackage object
 * @param  {String}   tableName   Table name to query
 * @param  {BoundingBox}   boundingBox BoundingBox to query
 * @param  {Function} callback    Caled with err, featureArray
 */
GeoPackageAPI.queryForGeoJSONFeaturesInTable = function(geoPackage, tableName, boundingBox) {
  return geoPackage.queryForGeoJSONFeaturesInTable(tableName, boundingBox);
}

/**
 * Iterates GeoJSON features in a feature table that matches the bounding box
 * @param  {GeoPackage}   geoPackage  open GeoPackage object
 * @param  {String}   tableName   Table name to query
 * @param  {BoundingBox}   boundingBox BoundingBox to query
 * @param  {Function} rowCallback    Caled with err, and GeoJSON feature
 * @param  {Function} doneCallback    Caled with err if one occurred
 */
GeoPackageAPI.iterateGeoJSONFeaturesInTableWithinBoundingBox = function(geoPackage, tableName, boundingBox, rowCallback) {
  return geoPackage.iterateGeoJSONFeaturesInTableWithinBoundingBox(tableName, boundingBox, rowCallback);
}


/**
 * Iterates GeoJSON features in a feature table that matches the bounding box
 * @param  {String}   geoPackagePath  path to the GeoPackage file
 * @param  {String}   tableName   Table name to query
 * @param  {BoundingBox}   boundingBox BoundingBox to query
 * @param  {Function} rowCallback    Caled with err, and GeoJSON feature
 * @param  {Function} doneCallback    Caled with err if one occurred
 */
GeoPackageAPI.iterateGeoJSONFeaturesFromPathInTableWithinBoundingBox = function(geoPackagePath, tableName, boundingBox, rowCallback) {
  return GeoPackageAPI.open(geoPackagePath)
  .then(function(geoPackage) {
    return geoPackage.iterateGeoJSONFeaturesInTableWithinBoundingBox(tableName, boundingBox, rowCallback);
  });
}

/**
 * Iterate GeoJSON features from table
 * @param  {GeoPackage} geopackage      open GeoPackage object
 * @param  {String} table           Table name to Iterate
 * @param  {Function} featureCallback called with an error if one occurred and the next GeoJSON feature in the table
 * @param  {Function} doneCallback    called when all rows are complete
 */
GeoPackageAPI.iterateGeoJSONFeaturesFromTable = function(geopackage, table, featureCallback) {
  return geopackage.getFeatureDaoWithTableName(table)
  .then(function(featureDao) {
    if (!featureDao) {
      throw new Error('No Table exists with the name ' + table);
    }
    var srs = featureDao.getSrs();
    return featureDao.queryForEach(function(err, row) {
      var currentRow = featureDao.getFeatureRow(row, srs);
      featureCallback(err, parseFeatureRowIntoGeoJSON(currentRow, srs));
    });
  });
};

/**
 * Gets a GeoJSON feature from the table by id
 * @param  {GeoPackage}   geopackage open GeoPackage object
 * @param  {String}   table      name of the table to get the feature from
 * @param  {Number}   featureId  ID of the feature
 * @param  {Function} callback   called with an error if one occurred and the GeoJSON feature
 */
GeoPackageAPI.getFeature = function(geopackage, table, featureId) {
  var srs;
  var featureDao;
  return geopackage.getFeatureDaoWithTableName(table)
  .then(function(fd) {
    featureDao = fd;
    srs = featureDao.getSrs();
    var feature = featureDao.queryForIdObject(featureId);
    if (feature) {
      return feature;
    } else {
      throw new Error();
    }
  })
  .catch(function() {
    return featureDao.queryForAllEqWithFieldAndValue('_feature_id', featureId)
    .then(function(features) {
      if (features.length) {
        return featureDao.getFeatureRow(features[0]);
      } else {
        throw new Error();
      }
    });
  })
  .catch(function() {
    return featureDao.queryForAllEqWithFieldAndValue('_properties_id', featureId)
    .then(function(features) {
      if (features.length) {
        return featureDao.getFeatureRow(features[0]);
      } else {
        throw new Error();
      }
    });
  })
  .then(function(feature) {
    if (feature) {
      return parseFeatureRowIntoGeoJSON(feature, srs);
    }
  });
};

function parseFeatureRowIntoGeoJSON(featureRow, srs) {
  var geoJson = {
    type: 'Feature',
    properties: {}
  };
  var geometry = featureRow.getGeometry();
  if (geometry && geometry.geometry) {
    var geom = geometry.geometry;
    var geoJsonGeom = geometry.geometry.toGeoJSON();
    if (srs.definition && srs.definition !== 'undefined' && (srs.organization.toUpperCase() + ':' + srs.organization_coordsys_id) != 'EPSG:4326') {
      geoJsonGeom = reproject.reproject(geoJsonGeom, srs.organization.toUpperCase() + ':' + srs.organization_coordsys_id, 'EPSG:4326');
    }
    geoJson.geometry = geoJsonGeom;
  }

  for (var key in featureRow.values) {
    if(featureRow.values.hasOwnProperty(key) && key != featureRow.getGeometryColumn().name && key != 'id') {
      if (key.toLowerCase() == '_feature_id') {
        geoJson.id = featureRow.values[key];
      } else if (key.toLowerCase() == '_properties_id') {
        geoJson.properties[key.substring(12)] = featureRow.values[key];
      } else {
        geoJson.properties[key] = featureRow.values[key];
      }
    } else if (featureRow.getGeometryColumn().name === key) {
      // geoJson.properties[key] = geometry && !geometry.geometryError ? 'Valid' : geometry.geometryError;
    }
  }
  geoJson.id = geoJson.id || featureRow.getId();
  return geoJson;
}


/**
 * Gets a tile from the specified table
 * @param  {GeoPackage}   geopackage open GeoPackage object
 * @param  {String}   table      name of the table to get the tile from
 * @param  {Number}   zoom       zoom level of the tile
 * @param  {Number}   tileRow    row of the tile
 * @param  {Number}   tileColumn column of the tile
 * @param  {Function} callback   called with an error if one occurred and the TileRow object
 */
GeoPackageAPI.getTileFromTable = function(geopackage, table, zoom, tileRow, tileColumn) {
  return geopackage.getTileDaoWithTableName(table)
  .then(function(tileDao) {
    return tileDao.queryForTile(tileColumn, tileRow, zoom);
  });
};

/**
 * Gets the tiles in the EPSG:4326 bounding box
 * @param  {GeoPackage}   geopackage open GeoPackage object
 * @param  {String}   table      name of the tile table
 * @param  {Number}   zoom       Zoom of the tiles to query for
 * @param  {Number}   west       EPSG:4326 western boundary
 * @param  {Number}   east       EPSG:4326 eastern boundary
 * @param  {Number}   south      EPSG:4326 southern boundary
 * @param  {Number}   north      EPSG:4326 northern boundary
 * @param  {Function} callback   called with an error if one occurred and a tiles object describing the tiles
 */
GeoPackageAPI.getTilesInBoundingBox = function(geopackage, table, zoom, west, east, south, north) {
  var tiles = {};

  return geopackage.getTileDaoWithTableName(table)
  .then(function(tileDao) {
    if (zoom < tileDao.minZoom || zoom > tileDao.maxZoom) {
      return callback();
    }
    tiles.columns = [];
    for (var i = 0; i < tileDao.table.columns.length; i++) {
      var column = tileDao.table.columns[i];
      tiles.columns.push({
        index: column.index,
        name: column.name,
        max: column.max,
        min: column.min,
        notNull: column.notNull,
        primaryKey: column.primaryKey
      });
    }
    var srs = tileDao.getSrs();
    tiles.srs = srs;
    tiles.tiles = [];

    var tms = tileDao.tileMatrixSet;
    var tm = tileDao.getTileMatrixWithZoomLevel(zoom);
    var mapBoundingBox = new BoundingBox(Math.max(-180, west), Math.min(east, 180), south, north);
    tiles.west = Math.max(-180, west).toFixed(2);
    tiles.east = Math.min(east, 180).toFixed(2);
    tiles.south = south.toFixed(2);
    tiles.north = north.toFixed(2);
    tiles.zoom = zoom;
    mapBoundingBox = mapBoundingBox.projectBoundingBox('EPSG:4326', tileDao.srs.organization.toUpperCase() + ':' + tileDao.srs.organization_coordsys_id);

    var grid = TileBoundingBoxUtils.getTileGridWithTotalBoundingBox(tms.getBoundingBox(), tm.matrix_width, tm.matrix_height, mapBoundingBox);

    return tileDao.queryByTileGrid(grid, zoom, function(err, row) {
      var tile = {};
      tile.tableName = table;
      tile.id = row.getId();

      var tileBB = TileBoundingBoxUtils.getTileBoundingBox(tms.getBoundingBox(), tm, row.getTileColumn(), row.getTileRow());
      tile.minLongitude = tileBB.minLongitude;
      tile.maxLongitude = tileBB.maxLongitude;
      tile.minLatitude = tileBB.minLatitude;
      tile.maxLatitude = tileBB.maxLatitude;
      tile.projection = tileDao.srs.organization.toUpperCase() + ':' + tileDao.srs.organization_coordsys_id;
      tile.values = [];
      for (var i = 0; i < tiles.columns.length; i++) {
        var value = row.values[tiles.columns[i].name];
        if (tiles.columns[i].name === 'tile_data') {
          tile.values.push('data');
        } else
        if (value === null || value === 'null') {
          tile.values.push('');
        } else {
          tile.values.push(value.toString());
          tile[tiles.columns[i].name] = value;
        }
      }
      tiles.tiles.push(tile);
    })
    .then(function(count) {
      return tiles;
    });
  });
};

/**
 * Gets the tiles in the EPSG:4326 bounding box
 * @param  {GeoPackage}   geopackage open GeoPackage object
 * @param  {String}   table      name of the tile table
 * @param  {Number}   zoom       Zoom of the tiles to query for
 * @param  {Number}   west       EPSG:4326 western boundary
 * @param  {Number}   east       EPSG:4326 eastern boundary
 * @param  {Number}   south      EPSG:4326 southern boundary
 * @param  {Number}   north      EPSG:4326 northern boundary
 * @param  {Function} callback   called with an error if one occurred and a tiles object describing the tiles
 */
GeoPackageAPI.getTilesInBoundingBoxWebZoom = function(geopackage, table, webZoom, west, east, south, north) {
  var tiles = {};

  return geopackage.getTileDaoWithTableName(table)
  .then(function(tileDao) {
    if (webZoom < tileDao.minWebZoom || webZoom > tileDao.maxWebZoom) {
      return callback();
    }
    tiles.columns = [];
    for (var i = 0; i < tileDao.table.columns.length; i++) {
      var column = tileDao.table.columns[i];
      tiles.columns.push({
        index: column.index,
        name: column.name,
        max: column.max,
        min: column.min,
        notNull: column.notNull,
        primaryKey: column.primaryKey
      });
    }
    var srs = tileDao.getSrs();
    tiles.srs = srs;
    tiles.tiles = [];

    var zoom = tileDao.webZoomToGeoPackageZoom(webZoom);

    var tms = tileDao.tileMatrixSet;
    var tm = tileDao.getTileMatrixWithZoomLevel(zoom);
    var mapBoundingBox = new BoundingBox(Math.max(-180, west), Math.min(east, 180), south, north);
    tiles.west = Math.max(-180, west).toFixed(2);
    tiles.east = Math.min(east, 180).toFixed(2);
    tiles.south = south.toFixed(2);
    tiles.north = north.toFixed(2);
    tiles.zoom = zoom;
    mapBoundingBox = mapBoundingBox.projectBoundingBox('EPSG:4326', tileDao.srs.organization.toUpperCase() + ':' + tileDao.srs.organization_coordsys_id);

    var grid = TileBoundingBoxUtils.getTileGridWithTotalBoundingBox(tms.getBoundingBox(), tm.matrix_width, tm.matrix_height, mapBoundingBox);

    return tileDao.queryByTileGrid(grid, zoom, function(err, row) {
      var tile = {};
      tile.tableName = table;
      tile.id = row.getId();

      var tileBB = TileBoundingBoxUtils.getTileBoundingBox(tms.getBoundingBox(), tm, row.getTileColumn(), row.getTileRow());
      tile.minLongitude = tileBB.minLongitude;
      tile.maxLongitude = tileBB.maxLongitude;
      tile.minLatitude = tileBB.minLatitude;
      tile.maxLatitude = tileBB.maxLatitude;
      tile.projection = tileDao.srs.organization.toUpperCase() + ':' + tileDao.srs.organization_coordsys_id;
      tile.values = [];
      for (var i = 0; i < tiles.columns.length; i++) {
        var value = row.values[tiles.columns[i].name];
        if (tiles.columns[i].name === 'tile_data') {
          tile.values.push('data');
        } else
        if (value === null || value === 'null') {
          tile.values.push('');
        } else {
          tile.values.push(value.toString());
          tile[tiles.columns[i].name] = value;
        }
      }
      tiles.tiles.push(tile);
    })
    .then(function(count) {
      return tiles;
    });
  });
};

GeoPackageAPI.getFeatureTileFromXYZ = function(geopackage, table, x, y, z, width, height) {
  x = Number(x);
  y = Number(y);
  z = Number(z);
  width = Number(width);
  height = Number(height);
  return geopackage.getFeatureDaoWithTableName(table)
  .then(function(featureDao) {
    if (!featureDao) return;
    var ft = new FeatureTile(featureDao, width, height);
    return ft.drawTile(x, y, z);
  });
}

/**
 * Gets the features in the EPSG:4326 bounding box
 * @param  {GeoPackage}   geopackage open GeoPackage object
 * @param  {String}   table      name of the feature table
 * @param  {Number}   west       EPSG:4326 western boundary
 * @param  {Number}   east       EPSG:4326 eastern boundary
 * @param  {Number}   south      EPSG:4326 southern boundary
 * @param  {Number}   north      EPSG:4326 northern boundary
 * @param  {Function} callback   called with an error if one occurred and a features array
 */
GeoPackageAPI.getGeoJSONFeaturesInTile = function(geopackage, table, x, y, z) {
  var webMercatorBoundingBox = TileBoundingBoxUtils.getWebMercatorBoundingBoxFromXYZ(x, y, z);
  var bb = webMercatorBoundingBox.projectBoundingBox('EPSG:3857', 'EPSG:4326');
  return geopackage.indexFeatureTable(table)
  .then(function(indexed) {
    return geopackage.getFeatureDaoWithTableName(table);
  })
  .then(function(featureDao) {
    if (!featureDao) return;
    var features = [];
    featureDao.queryForGeoJSONIndexedFeaturesWithBoundingBox(bb, function(err, feature) {
      features.push(feature);
    }).then(function(count) {
      return features;
    });
  });
}

/**
 * Gets the features in the EPSG:4326 bounding box
 * @param  {GeoPackage}   geopackage open GeoPackage object
 * @param  {String}   table      name of the feature table
 * @param  {Number}   west       EPSG:4326 western boundary
 * @param  {Number}   east       EPSG:4326 eastern boundary
 * @param  {Number}   south      EPSG:4326 southern boundary
 * @param  {Number}   north      EPSG:4326 northern boundary
 * @param  {Function} callback   called with an error if one occurred and a features array
 */
GeoPackageAPI.getFeaturesInBoundingBox = function(geopackage, table, west, east, south, north) {
  return geopackage.indexFeatureTable(table)
  .then(function(indexed) {
    return geopackage.getFeatureDaoWithTableName(table);
  })
  .then(function(featureDao) {
    if (!featureDao) throw new Error('Unable to find table ' + table);
    var features = [];
    var bb = new BoundingBox(west, east, south, north);
    return featureDao.queryIndexedFeaturesWithBoundingBox(bb, function(err, feature) {
      features.push(feature);
    })
    .then(function(count) {
      return features;
    });
  });
}

/**
 * Gets a tile image for an XYZ tile pyramid location
 * @param  {GeoPackage}   geopackage open GeoPackage object
 * @param  {String}   table      name of the table containing the tiles
 * @param  {Number}   x          x index of the tile
 * @param  {Number}   y          y index of the tile
 * @param  {Number}   z          zoom level of the tile
 * @param  {Number}   width      width of the resulting tile
 * @param  {Number}   height     height of the resulting tile
 * @param  {Function} callback   Called with an error if one occurred and the tile buffer
 */
GeoPackageAPI.getTileFromXYZ = function(geopackage, table, x, y, z, width, height, callback) {
  x = Number(x);
  y = Number(y);
  z = Number(z);
  width = Number(width);
  height = Number(height);
  geopackage.getTileDaoWithTableName(table)
  .then(function(tileDao) {
    var retriever = new GeoPackageTileRetriever(tileDao, width, height);
    retriever.getTile(x, y, z, callback);
  });
};

/**
 * Draws an XYZ tile pyramid location into the provided canvas
 * @param  {GeoPackage}   geopackage open GeoPackage object
 * @param  {String}   table      name of the table containing the tiles
 * @param  {Number}   x          x index of the tile
 * @param  {Number}   y          y index of the tile
 * @param  {Number}   z          zoom level of the tile
 * @param  {Number}   width      width of the resulting tile
 * @param  {Number}   height     height of the resulting tile
 * @param  {Canvas}   canvas     canvas element to draw the tile into
 * @param  {Function} callback   Called with an error if one occurred
 */
GeoPackageAPI.drawXYZTileInCanvas = function(geopackage, table, x, y, z, width, height, canvas, callback) {
  x = Number(x);
  y = Number(y);
  z = Number(z);
  width = Number(width);
  height = Number(height);
  geopackage.getTileDaoWithTableName(table)
  .then(function(tileDao) {
    var retriever = new GeoPackageTileRetriever(tileDao, width, height);
    retriever.drawTileIn(x, y, z, canvas, callback);
  });
};