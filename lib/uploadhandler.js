var EventEmitter = require('events').EventEmitter,
    path = require('path'),
    fs = require('fs'),
    formidable = require('formidable'),
    imageMagick = require('imagemagick'),
    mkdirp = require('mkdirp'),
    _ = require('lodash'),
    async = require('async');
    crypto = require('crypto');
var doNothing=function(){};

module.exports = function (options) {
    var FileInfo = require('./fileinfo')(
        _.extend({
            baseDir: options.uploadDir
        }, _.pick(options, 'minFileSize', 'maxFileSize', 'acceptFileTypes'))
    );

    var UploadHandler = function (req, res, callback) {
        EventEmitter.call(this);
        this.req = req;
        this.res = res;
        this.callback = callback;
    };
    require('util').inherits(UploadHandler, EventEmitter);

    UploadHandler.prototype.noCache = function () {
        this.res.set({
            'Pragma': 'no-cache',
            'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        if ((this.req.get("Accept") || "").indexOf("application/json") != -1) {
            this.res.set({
                'Content-Type': 'application/json',
                'Content-Disposition': 'inline; filename="files.json"'
            });
        } else {
            this.res.set({ 'Content-Type': 'text/plain' });
        }
    };

    UploadHandler.prototype.get = function () {
        this.noCache();
        var files = [];
        fs.readdir(options.uploadDir(), _.bind(function (err, list) {
            async.each(list, _.bind(function(name, cb) {
                fs.stat(options.uploadDir() + '/' + name, _.bind(function(err, stats) {
                    if (!err && stats.isFile()) {
                        var fileInfo = new FileInfo({
                            name: name,
                            size: stats.size
                        });
                        this.initUrls(fileInfo, function(err) {
                            files.push(fileInfo);
                            cb(err);
                        });
                    }
                    else cb(err);
                }, this));
            }, this),
            _.bind(function(err) {
                this.callback({files: files});
            }, this));
        }, this));
    };

    var isFileExist = function (filePath) {
        return fs.existsSync(filePath);
    }

    UploadHandler.prototype.post = function () {
        var self = this,
            form = new formidable.IncomingForm(),
            tmpFiles = [],
            files = [],
            map = {},
            counter = 1,
            redirect,
            finish = _.bind(function () {
                if (!--counter) {
                    async.each(files, _.bind(function(fileInfo, cb) {
                        this.initUrls(fileInfo, _.bind(function(err) {
                            this.emit('end', fileInfo);
                            cb(err);
                        }, this));
                    }, this),
                    _.bind(function(err) {
                        this.callback({files: files}, redirect);
                    }, this));
                }
            }, this);

        this.noCache();

        form.uploadDir = options.tmpDir;
        form.hash = "sha1";
        form
            .on('fileBegin', function (name, file) {
                tmpFiles.push(file.path);
                var fileInfo = new FileInfo(file);
                fileInfo.safeName();
                map[path.basename(file.path)] = fileInfo;
                files.push(fileInfo);
                self.emit('begin', fileInfo);
            })
            .on('field', function (name, value) {
                if (name === 'redirect') {
                    redirect = value;
                }
                if ( !self.req.fields )
                    self.req.fields = {};
                self.req.fields[name] = value;
            })
            .on('file', function (name, file) {
                counter++;
                var fileInfo = map[path.basename(file.path)];
                fs.exists(file.path, function(exists) {
                    if (exists) {
                        fileInfo.size = file.size;
                        if (!fileInfo.validate()) {
                            fs.unlink(file.path, doNothing);
                            finish();
                            return;
                        }

                        var generatePreviews = function () {
                            if (options.imageTypes.test(fileInfo.name)) {
                                _.each(options.imageVersions, function (value, version) {
                                    counter++;
                                    // creating directory recursive
                                    mkdirp(options.uploadDir() + '/' + version + '/', function (err, made) {
                                        var opts = options.imageVersions[version];
                                        imageMagick.resize({
                                            width: opts.width,
                                            height: opts.height,
                                            srcPath: options.uploadDir() + '/' + fileInfo.fileDir + '/' + fileInfo.name,
                                            dstPath: options.uploadDir() + '/' + version + '/' + fileInfo.name,
                                            customArgs: opts.imageArgs || ['-auto-orient']
                                        }, finish);
                                    });
                                });
                            }
                        }

                        mkdirp(options.uploadDir() + '/', function(err, made) {
                            //文件后缀
                            const fileSuffix = fileInfo.name.substring(fileInfo.name.lastIndexOf('.'));
                            const fileName = file.hash + fileSuffix;
                            //子目录
                            const fileDir = fileName.substring(0,2);
                            const filePath = path.join(fileDir+fileName);
                            fileInfo.fileDir = fileDir;
                            fileInfo.name = fileName;
                            const isExist = isFileExist(filePath);

                            if(isExist) {
                                finish();
                                return;
                            }

                            mkdirp(path.join(options.uploadDir(),fileDir), function(err, made_1) {
                                const new_path = path.join(options.uploadDir(),fileDir,fileName);
                                fs.rename(file.path, new_path, function (err) {
                                    if (!err) {
                                        // generatePreviews();
                                        finish();
                                    } else {
                                        var is = fs.createReadStream(file.path);
                                        var os = fs.createWriteStream(new_path);
                                        is.on('end', function (err) {
                                            if (!err) {
                                                fs.unlink(file.path, doNothing);
                                                // generatePreviews();
                                            }
                                            finish();
                                        });
                                        is.pipe(os);
                                    }
                                });
                            });
                        });
                    }
                    else finish();
                });
            })
            .on('aborted', function () {
                _.each(tmpFiles, function (file) {
                    var fileInfo = map[path.basename(file)];
                    self.emit('abort', fileInfo);
                    fs.unlink(file, doNothing);
                });
            })
            .on('error', function (e) {
                self.emit('error', e);
            })
            .on('progress', function (bytesReceived, bytesExpected) {
                if (bytesReceived > options.maxPostSize)
                    self.req.connection.destroy();
            })
            .on('end', finish)
            .parse(self.req);
    };

    UploadHandler.prototype.destroy = function () {
        var self = this,
            fileName = path.basename(decodeURIComponent(this.req.url));

        var filepath = path.join(options.uploadDir(), fileName);
        if (filepath.indexOf(options.uploadDir()) !== 0) {
            self.emit('delete', fileName);
            self.callback({success: false});
            return;
        }
        fs.unlink(filepath, function (ex) {
            _.each(options.imageVersions, function (value, version) {
                fs.unlink(path.join(options.uploadDir(), version, fileName), doNothing);
            });
            self.emit('delete', fileName);
            self.callback({success: !ex});
        });
    };

    UploadHandler.prototype.initUrls = function (fileInfo, cb) {
        var baseUrl = (options.ssl ? 'https:' : 'http:') + '//' + (options.hostname || this.req.get('Host'));
        fileInfo.setUrl(null, baseUrl + options.uploadUrl() + '/' + fileInfo.fileDir);
        fileInfo.setUrl('delete', baseUrl + this.req.originalUrl + '/' + fileInfo.fileDir);
        async.each(Object.keys(options.imageVersions), function(version, cb) {
            fs.exists(options.uploadDir() + '/' + version + '/' + fileInfo.name, function(exists) {
                if (exists) fileInfo.setUrl(version, baseUrl + options.uploadUrl() + '/' + version);
                cb(null);
            })
        },
        cb);
    };

    return UploadHandler;
}

