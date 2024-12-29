"use strict";

/* Default playback rate of flights */
const DEFAULT_RATE = 50;

/* Default duration of new images */
const DEFAULT_DURATION = 5;

/* Seconds to jump when seeking */
const JUMP_SECONDS = 10;

/* Default camera offset to track from */
const DEFAULT_VIEW = new Cesium.Cartesian3(50, -500, 1000);

/* The graphic for the play button */
const PLAY_BUTTON = 'data:image/svg+xml;utf8,<svg width="32" height="32" version="1.1" viewBox="0 0 2.4 2.4" xml:space="preserve" xmlns="http://www.w3.org/2000/svg"><path d="m1.2 0c-0.66168 0-1.2 0.53832-1.2 1.2s0.53832 1.2 1.2 1.2 1.2-0.53832 1.2-1.2-0.53832-1.2-1.2-1.2zm-0.42618 0.56016c0.00923 4.05e-4 0.018423 0.002725 0.026367 0.006885l1.1047 0.6c0.014127 0.00744 0.022559 0.019719 0.022559 0.032959s-0.00843 0.025666-0.022559 0.033106l-1.1047 0.6c-0.00875 0.0046-0.018954 0.00688-0.02915 0.00688-0.00828 0-0.01661-0.00142-0.02417-0.00454-0.016976-0.0069168-0.027539-0.020606-0.027539-0.035446v-1.2c0-0.01484 0.010615-0.028383 0.027539-0.035303 0.00849-0.00346 0.017721-0.004946 0.026953-0.004541z" stroke-width="0" fill="black"/></svg>';

/* Image extensions */
const IMAGE_EXTS = [ '.jpg', '.jpeg', '.png' ];

/* IGC file extensions */
const IGC_EXTS = [ '.igc' ];

/* Video extensions */
const VIDEO_EXTS = [ '.mp4', '.mov' ];

const viewer = new Cesium.Viewer('cesiumContainer', {
    terrain: Cesium.Terrain.fromWorldTerrain(),
    selectionIndicator: false,
    geocoder: false,
    scene3DOnly: true,
    projectionPicker: false,
    baseLayerPicker: false,
});

const state = {
    pilots: { },

    /* The entire set of intervals for the timeline */
    intervals: new Cesium.TimeIntervalCollection(),

    /* Timezone offset in seconds from UTC */
    timeZone: 0,

    /* Trailing time for drawing flights */
    trailing: null,

    /* Sub-folder currently being used */
    folder: null,

    /* Currently being displayed */
    pilot: null,
    any: null,
};

/* For Javascript console debugging */
window.viewer = viewer;
window.state = state;

/*
 * All colors available
 * https://htmlcolorcodes.com/color-chart/
 */
const colors = [
    "#3498db", "#F1C40F", "#E67E22", "#2ecc71", "#27AE60", "#16A085", "#1ABC9C",
    "#3498DB", "#8E44AD", "#9B59B6", "#E74C3C", "#C0392B", "#F39C12", "#D35400",
];

/* Helper to show an error via the Cesium error panel */
function problem(title, args) {
    const message = [ ];
    let error = null;
    for (let i = 0; i < args.length; i++) {
        if (args[i] && args[i].stack)
            error = args[i].stack;
        else
            message.push(String(args[i]));
    }
    viewer.cesiumWidget.showErrorPanel(title, message.join(" "), error);
}

function assert(/* ... */) {
    console.assert.apply(console, arguments);

    if (!arguments[0])
        problem("Code problem", [ "See javascript console for details" ]);
}

function failure(/* ... */) {
    console.error.apply(console, arguments);
    problem("Failure", arguments);
}

function warning(/* ... */) {
    console.warn.apply(console, arguments);
    problem("Warning", arguments);
}

function message(/* ... */) {
    console.info.apply(console, arguments);
}

function parseJulianDate(timestamp) {
    assert(timestamp);
    if (typeof timestamp == 'number')
        timestamp = new Date(Math.max(0, timestamp));
    if (typeof timestamp == 'object')
        return Cesium.JulianDate.fromDate(timestamp);
    if (typeof timestamp == 'string')
        return Cesium.JulianDate.fromIso8601(timestamp);
    assert(typeof timestamp == "invalid");
}

/* Returns the timezone offset in Seconds */
function parseTimeZone(timestamp) {
    if (!timestamp) /* No timezone set? Then current browser timezone */
        return -(new Date("1970-01-01T00:00:00").valueOf()) / 1000;
    if (typeof timestamp == 'number')
        return timestamp; // Seconds offset
    if (typeof timestamp == 'string') {
        const date = Cesium.JulianDate.fromIso8601("1970-01-01T00:00:00" + timestamp);
        return -Cesium.JulianDate.toDate(date).valueOf() / 1000;
    }
    assert(typeof timestamp == "invalid");
}

/* Returns the duration in seconds */
function parseDuration(timestamp) {
    if (typeof timestamp == 'number')
        return timestamp; // Numbers are seconds
    if (!timestamp)
        return undefined;
    let ex = null;
    if (typeof timestamp == "string") {
        try {
            const date = Cesium.JulianDate.fromIso8601("1970-01-01T" + timestamp + "Z");
            return Cesium.JulianDate.toDate(date).valueOf() / 1000;
        } catch(e) {
            ex = e;
        }
    }
    warning("Couldn't parse duration in metadata:", timestamp, ex);
    return undefined;
}

/*
 * Match the file name to various extension lists
 * provided as option alguments and return the
 * extension list that matches.
 */
function assumeFileType(filename /* ... */) {
    assert(typeof filename == "string");
    const lcase = filename.toLowerCase();
    for (let i = 1; i < arguments.length; i++) {
        assert(arguments[i].reduce);
        if (arguments[i].reduce((acc, ext) => acc + lcase.endsWith(ext), 0) > 0)
            return arguments[i];
    }
    return null;
}

class Flight {
    constructor(igcData, filename) {
        this.igcData = igcData;
        this.name = filename;

        this.paraglider = null;
        this.tracker = null;
        this.entities = null;
        this.interval = null;
    }

    save() {
        /* The JSON for this is just the filename */
        return this.name;
    }

    async create() {
        const igcData = this.igcData;
        let startTime = null;
        let endTime = null;

        const pilot = Pilot.ensure(igcData.pilot);

        // The SampledPositionedProperty stores the position/timestamp for each sample along the series.
        const paragliderPositions = new Cesium.SampledPositionProperty();
        const trackerPositions = new Cesium.SampledPositionProperty();
        const trackerCartesian = new Cesium.Cartesian3(0, 0, 0);
        const trackerStack = new Array();

        const TRACKER_WINDOW = 128;

        function updateTracker(drain) {
            if (drain || trackerStack.length >= TRACKER_WINDOW) {
                const bottom = trackerStack.shift();
                Cesium.Cartesian3.subtract(trackerCartesian, bottom.position, trackerCartesian);
            }

            if ((drain && trackerStack.length) || trackerStack.length > TRACKER_WINDOW / 2) {
                const average = new Cesium.Cartesian3(0, 0, 0);
                Cesium.Cartesian3.divideByScalar(trackerCartesian, trackerStack.length, average);

                const index = Math.max(0, trackerStack.length - TRACKER_WINDOW / 2);
                trackerPositions.addSample(trackerStack[index].time, average);
            }
        }

        const entities = [ ];
        const length = igcData.fixes.length;

        // Create a point for each.
        for (let i = 0; i < length; i++) {
            const fix = igcData.fixes[i];

            // const altitude = (fix.gpsAltitude + fix.pressureAltitude) / 2;
            const time = parseJulianDate(fix.timestamp);
            const altitude = fix.gpsAltitude - 70;
            const position = Cesium.Cartesian3.fromDegrees(fix.longitude, fix.latitude, altitude);

            /*
             * The starting, stopping point, an invisible marker.
             * To debug, trace entire track just change condition and pixelSize
             */
            if (i == 0 || i == length - 1) {
                entities.push(viewer.entities.add({
                    position: position,
                    point: { pixelSize: 0, color: Cesium.Color.BLUE }
                }));
            }

            paragliderPositions.addSample(time, position);

            trackerStack.push({ position: position, time: time });
            Cesium.Cartesian3.add(trackerCartesian, position, trackerCartesian);
            updateTracker();

            startTime = startTime || time;
            endTime = time;
        }


        /* Update the remaining average position of the tracker */
        while (trackerStack.length > 0)
            updateTracker(true);

        const interval = new Cesium.TimeInterval({
            start: startTime,
            stop: endTime,
            isStopIncluded: false,
            data: this
        });

        /* Extend flight availability by default to 12 hours after landing */
        const extended = endTime.clone();
        if (state.trailing)
            Cesium.JulianDate.addSeconds(endTime, state.trailing, extended);
        else
            Cesium.JulianDate.addHours(endTime, 12, extended);

        const paraglider = viewer.entities.add({
            availability: new Cesium.TimeIntervalCollection([
                interval, /* The actual time of the flight, extended avalability below */
                new Cesium.TimeInterval({ start: endTime, stop: extended })
            ]),
            position: paragliderPositions,
            point: { pixelSize: 10, color: pilot.color },
            // Automatically compute the orientation from the position.
            orientation: new Cesium.VelocityOrientationProperty(trackerPositions),
            path: new Cesium.PathGraphics({
                width: 1,
                leadTime: 0,
                trailTime: state.trailing || undefined,
                material: new Cesium.ColorMaterialProperty(pilot.color)
            })
        });

        const tracker = viewer.entities.add({
            availability: new Cesium.TimeIntervalCollection([ new Cesium.TimeInterval({
                start: startTime,
                stop: endTime
            }) ]),
            position: trackerPositions,
            point: { pixelSize: 0, color: Cesium.Color.BLUE },
            viewFrom: DEFAULT_VIEW,
            parent: paraglider,

            /*
             * Change pixelSize above to > 0 to visualize tracker position
             * path: new Cesium.PathGraphics( { width: 3 })
             */
        });

        /* Used for finding our flight based on the entity/interval */
        paraglider.data = this;
        tracker.data = this;
        entities.push(paraglider, tracker);

        this.entities = entities;
        this.paraglider = paraglider;
        this.tracker = tracker;
        this.interval = interval;

        pilot.add(this);
        assert(this.pilot == pilot);

        // TODO: This uses a private API
        assert(!this.range);
        this.range = viewer.timeline.addHighlightRange(pilot.color.toCssHexString(),
            3, pilot.index * 2);
        this.range.setRange(interval.start, interval.stop);
    }

    destroy() {
        // TODO: This uses private API
        assert(this.range);
        this.range.setRange(null, null);
        this.range = null;
        viewer.timeline.resize();

        while (this.entities && this.entities.length) {
            let entity = this.entities.pop();
            viewer.entities.remove(entity);
            entity.data = null;
        }
        this.entities = null;

        /* These entities are removed above */
        this.paraglider = null;
        this.tracker = null;

        this.pilot.remove(this);
        assert(this.pilot == null);

        this.interval.data = null;
        this.interval = null;

        viewer.timeline.zoomTo(state.intervals.start, state.intervals.stop);
    }
};

Flight.load = async function loadFlight(filename) {
    let igcData = { fixes: [ ], pilot: "" };

    try {
        const response = await fetch(folderPath(filename));
        if (response.ok) {
            const data = await response.text();
            igcData = IGCParser.parse(data);
        } else {
            if (response.status == 404)
                warning("IGC flight log file not found", filename);
            else
                warning("Couldn't load flight log file file", filename, response.status, response.statusText);
        }
    } catch (ex) {
        warning("Failure to parse IGC flight log file", filename, ":", error);
    }

    var flight = new Flight(igcData, filename);
    await flight.create();
    return flight;
}

class Video {
    constructor(videoData) {
        this.name = this.filename = videoData.filename;
        this.videoData = videoData;
        this.element = null;
        this.entities = [ ];
        this.rate = 1;

        this.ticker = null;
        this.originalRate = null;
    }

    save() {
        /* The JSON for this is the videoData */
        return this.videoData;
    }

    create() {
        const that = this;
        const videoData = that.videoData;

        if (videoData.rate) {
            if (typeof videoData.rate != "number" || videoData.rate <= 0)
                warning("Invalid rate for video:", videoData.rate);
            else
                that.rate = videoData.rate;
        }

        const isImage = !!assumeFileType(videoData.filename, IMAGE_EXTS);
        const element = document.createElement(isImage ? "div" : "video");
        element.setAttribute("class", "content");
        element.style.visibility = "hidden";

        const source = document.createElement(isImage ? 'img' : 'source');
        source.setAttribute('src', folderPath(videoData.filename));
        element.appendChild(source);

        /* Special code for the video */
        if (element.pause) {
            element.setAttribute("loop", "false");
            element.setAttribute("preload", "metadata");
            element.addEventListener("waiting", function(e) {
                console.log("Waiting", videoData.filename);
            });

            element.addEventListener("seeking", function(e) {
                console.log("Seeking", videoData.filename);
            });
        }
        document.body.appendChild(element);

        const pilot = Pilot.ensure(videoData.pilot);

        // TODO: Validate dates
        const start = parseJulianDate(videoData.timestamp);

        function completeVideo(resolve, reject) {
            const duration = parseDuration(videoData.duration) || DEFAULT_DURATION;
            const stop = start.clone();
            Cesium.JulianDate.addSeconds(start, duration * that.rate, stop);

            const interval = new Cesium.TimeInterval({
                start: start,
                stop: stop,
                isStopIncluded: false,
                data: that,
            });

            interval.data = that;
            that.interval = interval;

            pilot.add(that);
            assert(that.pilot == pilot);

            // TODO: This uses a private API
            assert(!that.range);
            that.range = viewer.timeline.addHighlightRange(pilot.color.toCssHexString(),
                3, pilot.index * 2 + 5);
            that.range.setRange(interval.start, interval.stop);

            resolve();
        }

        that.entities = [ ];

        /* The position of the video */
        let position = null;

        /* These values have to be correct or we wont see the video billboard. Shrug */
        if (videoData.longitude || videoData.latitude || videoData.altitude) {
            const longitude = videoData.longitude || 0;
            const latitude = videoData.latitude || 0;
            const altitude = videoData.altitude || 0;

            if (typeof longitude != "number" || Math.abs(longitude) > 180 ||
                typeof latitude != "number" ||  Math.abs(latitude) > 90 ||
                typeof altitude != "number" || altitude < 0) {
                warning("Invalid latitude/longitude/altitude position:",
                    latitude, longitude, altitude);
            } else {
                position = Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude);
            }
        }

        /* Find a flight that overlaps this video's start */
        if (!position) {
            const flight = pilot.flights.findDataForIntervalContainingDate(start);
            if (flight)
                position = flight.paraglider.position.getValue(start);
        }

        /* A billboard to see the video */
        if (position) {
            const datauri = PLAY_BUTTON.replace("black", pilot.color.toCssHexString()).replace('#', '%23');
            const billboard = viewer.entities.add({
                position: position,
                billboard: { image: datauri, width: 32, height: 32 },
            });

            billboard.data = that;
            that.entities.push(billboard);
        }

        that.element = element;
        that.element.data = that;

        return new Promise((resolve, reject) => {
            if (isImage || videoData.duration) {
                completeVideo(resolve, reject);
                return;
            }

            const timeout = window.setTimeout(function(ev) {
                element.removeEventListener("loadedmetadata", listener);
                window.clearTimeout(timeout);
                reject(new Error("Timeout finding duration of video: " + that.name));
            }, 10000);
            const listener = element.addEventListener("loadedmetadata", function(ev) {
                element.removeEventListener("loadedmetadata", listener);
                window.clearTimeout(timeout);
                if (element.duration) {
                    videoData.duration = element.duration;
                    completeVideo(resolve, reject);
                } else {
                    reject(new Error("Unable to find duration of video: " + that.name));
                }
            });
        });
    }

    destroy() {
        this.stop();

        assert(this.element);
        document.body.removeChild(this.element);
        this.element.data = null;

        while (this.entities && this.entities.length) {
            let entity = this.entities.pop();
            viewer.entities.remove(entity);
            entity.data = null;
        }
        this.entities = null;

        // TODO: This uses private API
        assert(this.range);
        this.range.setRange(null, null);
        this.range = null;
        viewer.timeline.resize();

        this.pilot.remove(this);
        assert(this.pilot == null);

        this.interval.data = null;
        this.interval = null;

        viewer.timeline.zoomTo(state.intervals.start, state.intervals.stop);
    }

    start() {
        const element = this.element;
        const interval = this.interval;
        const clock = viewer.clock;
        const rate = this.rate;
        const name = this.name;

        function syncVideo() {
            const at = Cesium.JulianDate.secondsDifference(clock.currentTime, interval.start) / rate;
            if (!Cesium.Math.equalsEpsilon(at, element.currentTime, Cesium.Math.EPSILON1, 1)) {
                console.log("Syncing", name, element.currentTime, "->", at);
                element.currentTime = at;
            }

            const direction = clock.multiplier < 0 ? 0.1 : 1;
            if (direction != element.playbackRate)
                element.playbackRate = direction;

            if (clock.shouldAnimate && element.paused)
                element.play();
            else if (!clock.shouldAnimate && !element.paused)
                element.pause();
        }

        const direction = viewer.clock.multiplier < 0 ? -1 : 1;
        this.originalRate = viewer.clock.multiplier;
        viewer.clock.multiplier = rate * direction;

        /* If this is a <video>, do a synchronizer */
        if (this.element.play) {
            this.ticker = viewer.clock.onTick.addEventListener(syncVideo);
            syncVideo(true);
        }

        /* Actually show the video */
        this.element.style.visibility = "visible";
    }

    stop() {
        this.element.style.visibility = "hidden";
        if (this.ticker)
            this.ticker(); /* Remove the onTick handler */
        this.ticker = null;
        if (this.element.pause)
            this.element.pause();
        var direction = viewer.clock.multiplier < 0 ? -1 : 1;
        viewer.clock.multiplier = Math.abs(this.originalRate) * direction;
    }
};

Video.load = async function loadVideo(videoData) {
    // TODO: Put all the validation here
    const video = new Video(videoData);
    await video.create();
    return video;
};

class Pilot {
    constructor(name) {
        assert(typeof name == "string");

        this.name = name;
        this.index = Object.keys(state.pilots).length;
        this.flights = new Cesium.TimeIntervalCollection();
        this.videos = new Cesium.TimeIntervalCollection();

        /* Each pilot gets a color, and keep them unique based on pilot string*/
        this.color = new Cesium.Color(0, 0, 0);
        Cesium.Color.fromCssColorString(colors.shift(), this.color);

        assert(!state.pilots[this.name]);

        let first = Object.values(state.pilots).at(0);
        state.pilots[this.name] = this;

        /* A linked list between all pilots */
        first = this.next = first || this;
        this.prev = this.next.prev || this;
        this.prev.next = this;
        this.next.prev = this;
    }

    add(obj) {
        assert(obj);
        assert(obj instanceof Flight || obj instanceof Video);
        assert(obj.interval.data == obj);

        /* Two interval collections depending on the type */
        const intervals = obj instanceof Flight ? this.flights : this.videos;

        /* Make sure this can be called multiple times */
        intervals.removeInterval(obj.interval);
        intervals.addInterval(obj.interval);

        /* This governs the whole timeline */
        state.intervals.addInterval(obj.interval.clone());

        obj.pilot = this;
    }

    remove(obj) {
        assert(obj);
        assert(obj instanceof Flight || obj instanceof Video);
        assert(obj.interval.data == obj);

        /* Two interval collections depending on the type */
        const intervals = obj instanceof Flight ? this.flights : this.videos;
        intervals.removeInterval(obj.interval);

        obj.pilot = null;
    }
};

Pilot.ensure = function ensurePilot(name) {
    assert(typeof name == "string");

    const pilot = state.pilots[name] || new Pilot(name);
    assert(state.pilots[name]);

    return pilot;
};

Pilot.change = function changePilot(pilot) {
    // Assume that the onTick will change
    state.pilot = pilot;
    const element = document.getElementById("pilot")
    element.innerText = pilot.name || "Any pilot";
    element.style.color = pilot.color.toCssHexString();
    console.log("Pilot", pilot.name);
}

function folderPath(path) {
    if (state.folder)
        return state.folder + "/" + path;
    return path
}

async function load(folder) {
    let metadata = { };

    /* The folder we retrieve all data from */
    state.folder = folder;

    try {
        const response = await fetch(folderPath("metadata.json"));
        if (response.ok) {
            metadata = await response.json();
        } else {
            if (response.status == 404)
                message("No metadata.json, starting with a blank screen");
            else
                warning("Couldn't load metadata.json file", response.status, response.statusText);
        }
    } catch (ex) {
        warning("Couldn't load metadata.json", ex);
    }

    /* Number of seconds to offset the timestamps */
    state.timeZone = parseTimeZone(metadata.timezone);

    /* Number of seconds to show flight trail behind active spot */
    state.trailing = parseDuration(metadata.trailing);

    const flights = metadata.flights || [];
    const videos = metadata.videos || [];

    for (let i = 0; i < flights.length; i++)
        await Flight.load(flights[i]);

    for (let i = 0; i < videos.length; i++)
        await Video.load(videos[i]);

    /* Switch to the first named pilot */
    const name = Object.keys(state.pilots).filter((n) => n).at(0);
    if (name)
        Pilot.change(state.pilots[name]);

    loaded(null);
}

function loaded(last) {
    let current = null;

    /* Recreate the global intervals, videos overlay flights */
    state.intervals = new Cesium.TimeIntervalCollection();
    Object.values(state.pilots).forEach(function(pilot) {
        for(let i = 0; i < pilot.flights.length; i++)
            state.intervals.addInterval(pilot.flights.get(i));
    });
    Object.values(state.pilots).forEach(function(pilot) {
        for(let i = 0; i < pilot.videos.length; i++)
            state.intervals.addInterval(pilot.videos.get(i));
    });

    /* Set up the timeline */
    if (state.intervals.length) {
        viewer.clock.startTime = state.intervals.start.clone();
        viewer.clock.stopTime = state.intervals.stop.clone();
        viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
        viewer.timeline.zoomTo(state.intervals.start, state.intervals.stop);
        current = state.intervals.start;
    }

    if (last)
        current = last.interval.start;

    if (current)
        viewer.clock.currentTime = current.clone();

    let entities = [];

    /* Fly to the item that was dropped */
    if (last) {
        Pilot.change(last.pilot);
        if (last instanceof Flight) {
            viewer.camera.position = DEFAULT_VIEW;
            entities = last.entities;
        }

    } else if (viewer.entities.values.length) {
        viewer.camera.position = DEFAULT_VIEW;
        entities = viewer.entities;
    }

    /* Do this after onTick */
    window.setTimeout(function() {
        viewer.flyTo(entities || [])
            .then((res) => console.log("flew", res))
            .catch((ex) => console.error("flew", ex));
    }, 0);
}

function initialize() {
    let currentFlight = null;
    let currentVideo = null;
    let trackedPosition = new Cesium.Cartesian3(0, 0, 0);
    let trackedCamera = Cesium.Cartesian3.clone(DEFAULT_VIEW);

    /* We initially have a any pilot */
    state.pilot = state.any = Pilot.ensure("");

    /* Change the tracked flight */
    function changeFlight(flight) {
        if (flight && flight.tracker) {
            const viewFrom = new Cesium.Cartesian3.clone(trackedCamera);
            Cesium.Cartesian3(viewFrom, trackedPosition, viewFrom);
            flight.tracker.viewFrom = viewFrom;
            viewer.trackedEntity = flight.tracker;
        } else {
            viewer.trackedEntity = null;
        }

        const old = currentFlight ? currentFlight.name : null;
        currentFlight = flight;

        console.log("Flight", old, "->", flight ? flight.name : null);
    }

    var timeout = null;
    var visible = true;

    function hideCesium() {
        if (visible) {
            document.getElementById("cesiumContainer").style.visibility = "hidden";
            viewer.cesiumWidget.targetFrameRate = 1;
        }
        visible = false;

        if (timeout !== null) {
            window.clearTimeout(timeout);
            timeout = null;
        }
    }

    function displayCesium() {
        if (timeout !== null) {
            window.clearTimeout(timeout);
            timeout = null;
        }
        if (currentVideo)
            timeout = window.setTimeout(hideCesium, 1000);
        if (!visible) {
            document.getElementById("cesiumContainer").style.visibility = "visible";
            viewer.cesiumWidget.targetFrameRate = undefined;
        }
        visible = true;
    }

    function changeVideo(video) {
        const old = currentVideo ? currentVideo.name : null;
        if (currentVideo)
            currentVideo.stop();
        currentVideo = video;
        if (video) {
            hideCesium();
            currentVideo.start(viewer.clock.currentTime);
        } else {
            displayCesium();
        }

        console.log("Video", old, "->", video ? video.name : null);
    }

    window.addEventListener("mousemove", function(e) {
        displayCesium();
        viewer.clock.onTick.raiseEvent(viewer.clock);
    });

    window.addEventListener("keydown", function(e) {
        /* PageUp and Page Down */
        if (e.keyCode == 33 || e.keyCode == 34) {
            if (e.keyCode == 33)
                Pilot.change(state.pilot.prev);
            else
                Pilot.change(state.pilot.next);

        /* Left or Right arrow keys (and optionally Ctrl modifier) */
        } else if (e.keyCode == 37 || e.keyCode == 39) {
            if (!state.intervals.length)
                return;

            const left = e.keyCode == 37;
            const ctrl = e.ctrlKey;
            const current = viewer.clock.currentTime;
            const jump = new Cesium.JulianDate(0, 0, Cesium.TimeStandard.UTC);
            const seconds = JUMP_SECONDS * (left ? -1 : 1) * Math.abs(viewer.clock.multiplier);

            let index = state.intervals.indexOf(current);
            let interval = null;

            function name() {
                assert(interval);
                return interval.data ? interval.data.name : index;
            }

            /* Do our boundary epsilon matching here */
            if (index >= 0) {
                interval = state.intervals.get(index);
                assert(interval);
                if (left && Cesium.JulianDate.equalsEpsilon(current, interval.start, 1)) {
                    console.log("Jump assuming before", name());
                    index = ~index; /* This is how we indicate we're before this interval */
                } else if (!left && Cesium.JulianDate.equalsEpsilon(current, interval.stop)) {
                    console.log("Jumping assuming after", name());
                    index = ~(index + 1);
                }
            }
            if (index < 0) {
                if (left) {
                    interval = state.intervals.get((~index) - 1);
                    if (interval && Cesium.JulianDate.equalsEpsilon(current, interval.stop, 1)) {
                        console.log("Jump assuming within", name());
                        index = (~index) - 1;
                    }
                } else {
                    interval = state.intervals.get(~index);
                    if (interval && Cesium.JulianDate.equalsEpsilon(current, interval.start, 1)) {
                        console.log("Jump assuming within", name());
                        index = ~index;
                    }
                }
            }

            if (index >= 0) {
                interval = state.intervals.get(index);
                assert(interval);

                /* We're at the start of the first interval */
                if (index == 0 && ctrl && left &&
                    Cesium.JulianDate.equalsEpsilon(current, interval.start, 1)) {

                    console.log("Jumping to beginning");
                    Cesium.JulianDate.clone(viewer.clock.startTime, jump);

                /* We're at the end of the very last interval */
                } else if (index == state.intervals.length && ctrl && !left &&
                    Cesium.JulianDate.equalsEpsilon(current, interval.stop)) {

                    /* We're at the end of the very last interval */
                    if (ctrl && index == state.intervals.length < 1) {
                        console.log("Jumping to ending");
                        Cesium.JulianDate.clone(viewer.clock.stopTime, jump);
                    }

                /* Jump to the start of the interval */
                } else if (ctrl && left) {
                    console.log("Jumping to start", name());
                    Cesium.JulianDate.clone(interval.start, jump);

                /* Jump to the stop of the interval */
                } else if (ctrl && !left) {
                    console.log("Jumping to stop", name());
                    Cesium.JulianDate.clone(interval.stop, jump);

                /* Plain Arrow key */
                } else if (!ctrl) {
                    Cesium.JulianDate.addSeconds(current, seconds, jump);

                    /* Jumping out of this interval, fall through to code below */
                    if (state.intervals.indexOf(jump) != index)
                        jump.dayNumber = jump.secondsOfDay = 0;
                    else
                        console.log("Jumping", seconds, left ? "backwards in" : "forwards in", name());
                }
            }


            if (!jump.dayNumber) {

                /* Not in an interval. Ctrl jumps to the previous */
                if (ctrl && left) {
                    interval = state.intervals.get((~index) - 1);
                    if (interval) {
                        console.log("Jumping to prev stop", name());
                        Cesium.JulianDate.clone(interval.stop, jump);
                    } else {
                        console.log("Jumping to beginning");
                        Cesium.JulianDate.clone(viewer.clock.startTime, jump);
                    }

                /* Ctrl outside of a video jumping forwards */
                } else if (ctrl && !left) {
                    interval = state.intervals.get(~index);
                    if (interval) {
                        console.log("Jumping to next start", name());
                        Cesium.JulianDate.clone(interval.start, jump);
                    } else {
                        console.log("Jumping to ending");
                        Cesium.JulianDate.clone(viewer.clock.stopTime, jump);
                    }

                /* And the standard jump outside of an interval */
                } else {
                    Cesium.JulianDate.addSeconds(current, seconds, jump);
                    console.log("Jumping", seconds, left ? "backwards" : "forwards");
                }
            }

            if (!jump.dayNumber) {
                /* Again, if we're still in an interval, then jump to edge */
                if (index >= 0) {
                    interval = state.intervals.get(index);
                    console.log("Jumping to", left ? "start of" : "stop of", name());
                    Cesium.JulianDate.clone(left ? interval.start : interval.stop, jump);
                }
            }


            /* By now we should have reached a decision on where to go */
            assert(jump.dayNumber);

            /* See if we need to expand */
            let expanded = false;
            if (left) {
                if (Cesium.JulianDate.lessThan(jump, viewer.clock.startTime)) {
                    viewer.clock.startTime = jump.clone();
                    console.log("Expanding beginning of timeline", jump.toString());
                    expanded = true;
                }
            } else {
                if (Cesium.JulianDate.greaterThan(jump, viewer.clock.stopTime)) {
                    viewer.clock.stopTime = jump.clone();
                    console.log("Expanding end of timeline", jump.toString());
                    expanded = true;
                }
            }

            if (expanded)
                viewer.timeline.zoomTo(viewer.clock.startTime, viewer.clock.stopTime);

            /* One shouldn't be able to expand with Ctrl */
            assert(!expanded || !ctrl);

            /* Actually do the jump here */
            viewer.clock.currentTime = jump;
        }

        viewer.clock.onTick.raiseEvent(viewer.clock);
    }, true);

    window.addEventListener("keypress", function(e) {
        /* Spacebar: pause/play clock */
        if (e.keyCode == 32) {
            viewer.animation.viewModel.pauseViewModel.command();
            viewer.clock.onTick.raiseEvent(viewer.clock);
            e.preventDefault();
            return true;

        /* Delete: delete the object */
        } else if (e.keyCode == 127) {
            console.log("delete", currentVideo, currentFlight);
            if (currentVideo) {
                const video = currentVideo;
                changeVideo(null);
                video.destroy();
            } else if (currentFlight) {
                const flight = currentFlight;
                changeFlight(null);
                flight.destroy();
            }
        }
    }, true);

    viewer.animation.viewModel.dateFormatter = function(date, viewModel) {
        const offset = new Cesium.JulianDate();
        Cesium.JulianDate.addSeconds(date, state.displayTimeZone, offset);
        return Cesium.JulianDate.toIso8601(offset, 0).slice(0, 10);
    };

    viewer.animation.viewModel.timeFormatter = function(date, viewModel) {
        const offset = new Cesium.JulianDate();
        Cesium.JulianDate.addSeconds(date, state.timeZone, offset);
        return Cesium.JulianDate.toIso8601(offset, 0).slice(11, 19);
    };

    viewer.timeline.makeLabel = function(date) {
        const offset = new Cesium.JulianDate();
        Cesium.JulianDate.addSeconds(date, state.timeZone, offset);
        return Cesium.JulianDate.toIso8601(offset, 0).slice(11, 16);
    };

    viewer.selectedEntityChanged.addEventListener(function(entity) {
        if (!entity || !entity.data)
            return;

        const obj = entity.data;
        const interval = obj.interval;
        if (!interval || !obj.pilot)
            return;

        let change = false;

        /* Make sure a valid pilot is selected for this entity */
        if (state.pilot != obj.pilot) {
            Pilot.change(obj.pilot);
            change = true;
        }

        /* And jump to the entity */
        if (!Cesium.TimeInterval.contains(interval, viewer.clock.currentTime)) {
            viewer.clock.currentTime = interval.start;
            change = true;
        }

        /* Start playing if we changed something */
        if (change)
            viewer.clock.shouldAnimate = true;
    });

    /* Here we store the base playback rate (ie: clock multiplier) */
    viewer.clock.multiplier = DEFAULT_RATE;

    viewer.clock.onTick.addEventListener(function(clock) {
        const pilot = state.pilot;
        const any = state.any;

        /* Note the tracked entity's position for use when changing trackers */
        if (viewer.trackedEntity) {
            viewer.trackedEntity.position.getValue(clock.currentTime, trackedPosition);
            Cesium.Cartesian3.clone(viewer.camera.position, trackedCamera);
        }

        /* The flight and video we should be on */
        const fint = pilot.flights.findIntervalContainingDate(clock.currentTime);
        const flight = fint ? fint.data : null;
        let vint = pilot.videos.findIntervalContainingDate(clock.currentTime);
        let video = vint ? vint.data : null;

        /* Look for videos on the any pilot */
        if (!video && pilot != any) {
            vint = any.videos.findIntervalContainingDate(clock.currentTime);
            video = vint ? vint.data : null;
        }

        /* Do we need to change the flight, or clear it? */
        if (flight != currentFlight)
            changeFlight(flight);

        /* Do we need to change the video, or clear it? */
        if (video != currentVideo)
            changeVideo(video);
    });

    function highlightEvent(ev) {
        const over = (ev.type == "dragover" || ev.type == "dragenter");
        document.body.classList.toggle("highlight", over);
        ev.preventDefault();
        ev.stopPropagation();
        return true;
    }

    function pixelToLocation(x, y) {
        const ray = viewer.camera.getPickRay(new Cesium.Cartesian2(x, y));
        var cartesian = viewer.scene.globe.pick(ray, viewer.scene);
        if (!cartesian)
            return null;
        const cartographic = viewer.scene.globe.ellipsoid.cartesianToCartographic(cartesian);
        return {
            latitude: Cesium.Math.toDegrees(cartographic.latitude),
            longitude: Cesium.Math.toDegrees(cartographic.longitude),
            altitude: cartographic.height
        };
    }

    window.addEventListener("dragover", highlightEvent);
    window.addEventListener("dragenter", highlightEvent);
    window.addEventListener("dragleave", highlightEvent);
    window.addEventListener("drop", function(ev) {
        if (ev.dataTransfer && ev.dataTransfer.files) {
            const files = ev.dataTransfer.files;
            for (let i = 0; i < files.length; i++) {
                const exts = assumeFileType(files[i].name, IMAGE_EXTS, IGC_EXTS, VIDEO_EXTS);
                let promise = null;
                if (exts == IGC_EXTS) {
                    promise = Flight.load(files[i].name);
                } else if (exts) {
                    const coordinates = currentFlight ? null : pixelToLocation(ev.clientX, ev.clientY);
                    promise = Video.load(Object.assign({
                        filename: files[i].name,
                        pilot: state.pilot.name,
                        timestamp: Cesium.JulianDate.toIso8601(viewer.clock.currentTime, 0)
                    }, coordinates));

                /* Here we assume that if no file extension, it's a folder. Shrug */
                } else if (files[i].name.indexOf(".") < 0) {
                    // TODO: Perhaps use items[i].webkitGetAsEntry() or similar to determine folder
                    console.log("Assuming dropped item is a folder", files[i]);

                    /* The location has determines our subfolder, so set that and reload app */
                    location.hash = files[i].name;

                    /* Yes we ignore any other files */
                    break;

                } else {
                    warning ("Couldn't load unsupported dropped item:", files[i].name);
                }

                if (promise) {
                    promise.then(function(obj) {
                        loaded(obj);
                    }).catch(function(ex) {
                        failure("Couldn't load file", files[i].name, ex)
                    });
                }
            }
        }
        return highlightEvent(ev);
    });

    /* Override the Ctrl-C to provide metadata.json */
    document.addEventListener('copy', function(ev) {
        ev.preventDefault();

        const data = {
            flights: [],
            videos: [],
            timezone: state.timeZone,
            trailing: state.trailing,
        };

        Object.values(state.pilots).forEach(function(pilot) {
            for(let i = 0; i < pilot.flights.length; i++) {
                const item = pilot.flights.get(i).data.save();
                data.flights.push(item);
            }
            for(let i = 0; i < pilot.videos.length; i++) {
                const item = pilot.videos.get(i).data.save();
                data.videos.push(item);
            }
        });

        const json = JSON.stringify(data, null, 4);
        ev.clipboardData.setData('text/plain', json);
    });

    /* The hash is our folder, we need to start fresh when it changes */
    window.addEventListener("hashchange", function(ev) {
        location.reload();
    });

    viewer.homeButton.viewModel.command.beforeExecute.addEventListener(function(ev) {
        ev.cancel = true;
        viewer.flyTo(viewer.entities || []);
    });

    document.getElementById("pilot").addEventListener("click", function(ev) {
        Pilot.change(state.pilot.next);
    });
}

initialize();

/* Load the folder described by the #bookmark in URI */
load(location.hash ? location.hash.substr(1) : null)
