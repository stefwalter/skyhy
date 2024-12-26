/* Default playback rate of flights */
const DEFAULT_RATE = 50;
const DEFAULT_VIEW = new Cesium.Cartesian3(50, -500, 1000);

const viewer = new Cesium.Viewer('cesiumContainer', {
    terrain: Cesium.Terrain.fromWorldTerrain(),
});

const state = {
    pilots: { },
    tzOffset: 0,

    /* Currently being displayed */
    pilot: null,
    flight: null,
    video: null,
    rate: DEFAULT_RATE,
};

/*
 * All colors available
 * https://htmlcolorcodes.com/color-chart/
 */
const colors = [
    "#000000", "#F1C40F", "#E67E22", "#2ecc71", "#27AE60", "#16A085", "#1ABC9C",
    "#3498DB", "#8E44AD", "#9B59B6", "#E74C3C", "#C0392B", "#F39C12", "#D35400",
];

function assert() {
    console.assert.apply(console, arguments);
}

function failure() {
    console.error.apply(console, arguments);
}

function warning() {
    console.warn.apply(console, arguments);
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
    if (!timestamp)
        return 0;
    if (typeof timestamp == 'number')
        return timestamp * 60; // Minutes offset
    if (typeof timestamp == 'string') {
        const date = Cesium.JulianDate.fromIso8601("1970-01-01T00:00:00" + timestamp);
        return -Cesium.JulianDate.toDate(date).valueOf() / 1000;
    }
    assert(typeof timestamp == "invalid");
}

/* Returns the duration in milliseconds */
function parseDuration(timestamp) {
    if (!timestamp)
        return 0;
    if (typeof timestamp == 'number')
        return timestamp * 1000; // Numbers are seconds, convert to ms
    assert(typeof timestamp == "string");
    try {
        const date = Cesium.JulianDate.fromIso8601("1970-01-01T" + timestamp + "Z");
        return Cesium.JulianDate.toDate(date).valueOf();
    } catch(e) {
        warning("Couldn't parse duration:", timestamp, e);
        return 0;
    }
}

class Flight {
    constructor(igcData, name) {
        let startTime = null;
        let endTime = null;

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

        // Create a point for each.
        for (let i = 0; i < igcData.fixes.length; i++) {
            const fix = igcData.fixes[i];

            // const altitude = (fix.gpsAltitude + fix.pressureAltitude) / 2;
            const time = parseJulianDate(fix.timestamp);
            const altitude = fix.gpsAltitude - 70;
            const position = Cesium.Cartesian3.fromDegrees(fix.longitude, fix.latitude, altitude);

            paragliderPositions.addSample(time, position);

            trackerStack.push({ position: position, time: time });
            Cesium.Cartesian3.add(trackerCartesian, position, trackerCartesian);
            updateTracker();

            /*
             * Example code for tracing the entire track
             *
             * const point = viewer.entities.add({
             *   description: `Location: (${fix.longitude}, ${fix.latitude}, ${altitude})`,
             *   position: position,
             *   point: { pixelSize: 10, color: Cesium.Color.RED }
             *});
             */

            startTime = startTime || time;
            endTime = time;
        }

        /* Update the remaining average position of the tracker */
        while (trackerStack.length > 0)
            updateTracker(true);

        /* Each pilot gets a color, and keep them unique based on pilot string*/
        const pilot = Pilot.ensure(igcData.pilot);

        const interval = new Cesium.TimeInterval({
            start: startTime,
            stop: endTime
        });

        // Load the glTF model from Cesium ion.
        const paraglider = viewer.entities.add({
            availability: new Cesium.TimeIntervalCollection([ interval ]),
            position: paragliderPositions,
            point: { pixelSize: 10, color: pilot.color },
            // Automatically compute the orientation from the position.
            orientation: new Cesium.VelocityOrientationProperty(trackerPositions),
            path: new Cesium.PathGraphics({
                width: 1,
                leadTime: 0,
                material: new Cesium.ColorMaterialProperty(pilot.color)
            })
        });

        /*
            // Create an entity to both visualize the sample series with a line and create a tracker
    viewer.entities.add({
        availability: new Cesium.TimeIntervalCollection([ new Cesium.TimeInterval({
            start: startTime,
            stop: endTime
        }) ]),
        position: trackerPositions,
        point: { pixelSize: 30, color: Cesium.Color.GREEN },
        path: new Cesium.PathGraphics( { width: 3 })
    });
    */
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
        interval.data = this;
        paraglider.flight = this;
        tracker.flight = this;

        this.name = name;
        this.paraglider = paraglider;
        this.tracker = tracker;
        this.interval = interval;
        pilot.add(this);
    }
};

Flight.load = async function loadFlight(filename) {

    // TODO: Escape properly
    // TODO: Hnadle errors
    const response = await fetch("./flight/" + filename);
    const igcData = await response.json();
    return new Flight(igcData, filename);
}

class Video {
    constructor(videoData) {
        const element = document.createElement("video");
        element.setAttribute("loop", "false");
        element.setAttribute("hidden", "hidden");
        const source = document.createElement('source');
        // TODO: Validate source
        source.setAttribute('src', videoData.filename);
        element.appendChild(source);
        document.body.appendChild(element);

        element.addEventListener("waiting", function(e) {
            console.log("Video waiting", videoData.filename);
        });

        element.addEventListener("seeking", function(e) {
            console.log("Video seeking", videoData.filename);
        });

        // TODO: Validate dates
        const start = parseJulianDate(videoData.timestamp);
        const stop = start.clone();
        const duration = parseDuration(videoData.duration);
        Cesium.JulianDate.addSeconds(start, duration / 1000, stop);

        const interval = new Cesium.TimeInterval({
            start: start,
            stop: stop
        });

        interval.data = this;

        this.name = videoData.filename;
        this.element = element;
        this.element.data = this;
        this.interval = interval;
        this.synchronizer = null;
        this.rate = videoData.speed || 1.0;
        Pilot.ensure(videoData.pilot).add(this);
    }

    start() {
        this.element.hidden = false;
        this.synchronizer = new Cesium.VideoSynchronizer({
            clock: viewer.clock,
            element: this.element,
            epoch: this.interval.start,
        });

        /* Store the old rate */
        state.rate = viewer.clock.multiplier;
        viewer.clock.multiplier = this.rate;
    }

    stop() {
        if (this.synchronizer) {
            this.synchronizer.destroy();
            this.synchronizer = null;
        }

        this.element.hidden = true;
        this.element.pause();
        viewer.clock.multiplier = state.rate;
    }
};

Video.load = function loadVideo(videoData) {
    // TODO: Put all the validation here
    return new Video(videoData);
}

class Pilot {
    constructor(name) {
        this.name = name;
        this.index = Object.keys(state.pilots).length;
        this.flights = new Cesium.TimeIntervalCollection();
        this.videos = new Cesium.TimeIntervalCollection();

        /* Each pilot gets a color, and keep them unique based on pilot string*/
        this.color = new Cesium.Color(0, 0, 0);
        Cesium.Color.fromCssColorString(colors.pop(), this.color);
    }

    add(obj) {
        assert(obj);
        assert(obj instanceof Flight || obj instanceof Video);
        assert(obj.interval.data == obj);

        /* Two interval collections depending on the type */
        const intervals = obj instanceof Flight ? this.flights : this.videos;
        if (intervals.indexOf(obj.interval.start) >= 0 ||
            intervals.indexOf(obj.interval.stop) >= 0) {
            warning("ignoring overlapping timespan:", obj.name, this.name);
            return;
        }

        intervals.addInterval(obj.interval);
    }
};

Pilot.ensure = function ensurePilot(name) {
    const key = name || "";
    const pilot = state.pilots[key] || new Pilot(key);
    return state.pilots[key] = pilot;
};

Pilot.complete = function completePilots() {

    /* The null pilot stuff gets added to all pilots */
    const npilot = state.pilots[""] || new Pilot("");
    delete state.pilots[""];

    let first = null;

    Object.values(state.pilots).forEach(function(pilot) {
        for (let i = 0; i < npilot.flights.length; i++) {
            const interval = npilot.flights.get(i);
            pilot.add(interval.data);
        }
        for (let i = 0; i < npilot.videos.length; i++) {
            const interval = npilot.videos.get(i);
            pilot.add(interval.data);
        }

        /* A linked list between all pilots */
        first = pilot.next = first || pilot;
        pilot.prev = pilot.next.prev || pilot;
        pilot.prev.next = pilot;
        pilot.next.prev = pilot;
    });

    Pilot.change(first);
}

Pilot.change = function changePilot(pilot) {
    assert(pilot);
    // Assume that the onTick will change
    state.pilot = pilot;
    const element = document.getElementById("pilot")
    element.innerText = pilot.name;
    element.style.color = pilot.color.toCssHexString();
    console.log("Pilot", pilot.name);
}

async function load() {
    const response = await fetch("./metadata.json");
    // TODO: Validate contents
    const metadata = await response.json();

    /* Number of milliseconds to offset the timestamps */
    state.tzOffset = parseTimeZone(metadata.timezone || 0);

    const flights = metadata.flights || [];

    /* For calculating the entire timeframe */
    const intervals = new Cesium.TimeIntervalCollection();

    for (let i = 0; i < flights.length; i++)
        await Flight.load(flights[i]);

    // TODO: Video positions
    for (let i = 0; i < metadata.videos.length; i++)
        await Video.load(metadata.videos[i]);

    Pilot.complete();

    Object.values(state.pilots).forEach(function(pilot) {
        for (let i = 0; i < pilot.flights.length; i++) {
            const flight = pilot.flights.get(i).data;
            intervals.addInterval(flight.interval);

            // TODO: This uses a private API
            const range = viewer.timeline.addHighlightRange(pilot.color.toCssHexString(), 3, pilot.index * 2);
            range.setRange(flight.interval.start, flight.interval.stop);
        }

        for (let i = 0; i < pilot.videos.length; i++) {
            // TODO: Video positions
            const video = pilot.videos.get(i).data;
            intervals.addInterval(video.interval);

            // TODO: This uses a private API
            const range = viewer.timeline.addHighlightRange(pilot.color.toCssHexString(), 3, pilot.index * 2 + 5);
            range.setRange(video.interval.start, video.interval.stop);
        }
    });

    /* Set up the timeline */
    if (intervals.length) {
        viewer.clock.startTime = intervals.start.clone();
        viewer.clock.stopTime = intervals.stop.clone();
        viewer.clock.currentTime = intervals.start.clone();
        viewer.timeline.zoomTo(intervals.start, intervals.stop);
        viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
    }

    /* Set up the default camera */
    viewer.flyTo(viewer.entities);
    viewer.camera.position = DEFAULT_VIEW;
}

function initialize() {

    /* We always have a null pilot */
    Pilot.ensure(null);

    /* Change the tracked flight */
    function changeFlight(flight) {
        const position = viewer.camera.position.clone();
        viewer.trackedEntity = flight ? flight.tracker : null;

        const old = state.flight ? state.flight.name : null;
        state.flight = flight;

        /* Note that we keep the pilot, even when setting null flight */
        if (flight) {
            if (old) {
                viewer.camera.position = position;
                flight.tracker.viewFrom = position;
            }
        }

        console.log("Flight", old, "->", flight ? flight.name : null);
    }

    function changeVideo(video) {
        const old = state.video ? state.video.name : null;
        if (state.video)
            state.video.stop();
        state.video = video;
        if (video)
            state.video.start(viewer.clock.currentTime);

        console.log("Video", old, "->", video ? video.name : null);
    }

    let tabDown = false;

    window.addEventListener("keydown", function(e) {
        tabDown = true;
    }, true);

    window.addEventListener("blur", function(e) {
        if (e.target == window)
            tabDown = false;
    }, true);

    window.addEventListener("keyup", function(e) {
        if (e.keyCode == 9 && tabDown && state.pilot) {
            if (e.shiftKey)
                Pilot.change(state.pilot.prev);
            else
                Pilot.change(state.pilot.next);
            e.preventDefault();
            return true;
        }
    }, true);

    window.addEventListener("keypress", function(e) {
        if (e.keyCode == 32) {
            viewer.animation.viewModel.pauseViewModel.command();
            e.preventDefault();
            return true;
        }
    }, true);

    viewer.animation.viewModel.dateFormatter = function(date, viewModel) {
        const offset = new Cesium.JulianDate();
        Cesium.JulianDate.addSeconds(date, state.tzOffset, offset);
        return Cesium.JulianDate.toIso8601(offset, 0).slice(0, 10);
    };

    viewer.animation.viewModel.timeFormatter = function(date, viewModel) {
        const offset = new Cesium.JulianDate();
        Cesium.JulianDate.addSeconds(date, state.tzOffset, offset);
        return Cesium.JulianDate.toIso8601(offset, 0).slice(11, 19);
    };

    viewer.timeline.makeLabel = function(date) {
        const offset = new Cesium.JulianDate();
        Cesium.JulianDate.addSeconds(date, state.tzOffset, offset);
        return Cesium.JulianDate.toIso8601(offset, 0).slice(11, 16);
    };

    viewer.trackedEntityChanged.addEventListener(function(entity) {
        // TODO: Do we need this function
    });

    /* Here we store the base playback rate (ie: clock multiplier) */
    let defaultRate = DEFAULT_RATE;
    viewer.clock.multiplier = defaultRate;

    viewer.clock.onTick.addEventListener(function(clock) {
        const pilot = state.pilot;
        if (!pilot)
            return;

        /* The flight and video we should be on */
        const fint = pilot.flights.findIntervalContainingDate(clock.currentTime);
        const flight = fint ? fint.data : null;
        const vint = pilot.videos.findIntervalContainingDate(clock.currentTime);
        const video = vint ? vint.data : null;

        if (flight != state.flight)
            changeFlight(flight);
        if (video != state.video)
            changeVideo(video);
    });
}

initialize();
load();
