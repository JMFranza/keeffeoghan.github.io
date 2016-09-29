/* global Uint8Array, Float32Array */

import 'pepjs';
import glContext from 'gl-context';
import vkey from 'vkey';
import getUserMedia from 'getusermedia';
import analyser from 'web-audio-analyser';
import soundCloud from 'soundcloud-badge';
import offset from 'mouse-event-offset';
import throttle from 'lodash/throttle';
import mapRange from 'range-fit';
import mat3 from 'gl-matrix/src/gl-matrix/mat3';
import vec2 from 'gl-matrix/src/gl-matrix/vec2';
import querystring from 'querystring';
import dat from 'dat-gui';

import redirect from '../utils/protocol-redirect';

import { Tendrils, defaults, glSettings } from './';

import { step } from '../utils';

import * as spawnPixels from './spawn/pixels';
import spawnPixelsFlowFrag from './spawn/pixels/flow.frag';
import spawnPixelsSimpleFrag from './spawn/pixels/data.frag';

import spawnReset from './spawn/ball';

import FlowLine from './flow-line/';

import makeAudioData from './audio/data';
import { makeLog, makeOrderLog } from './data-log';
import { orderLogRates, peak, sum, mean, weightedMean } from './analyse';

const queries = querystring.parse(location.search.slice(1));

const defaultSettings = defaults().state;

export default (canvas, settings, debug) => {
    if(redirect()) {
        return;
    }

    let tendrils;

    let flowInput;

    let trackAnalyser;
    let trackOrderLog;

    let micAnalyser;
    let micOrderLog;

    const audioDefaults = {
        trackURL: ((queries.track)?
                decodeURIComponent(queries.track)
            :   'https://soundcloud.com/max-cooper/waves-1'),

        audible: !('mute' in queries),

        track: !('track_off' in queries),
        trackBeatAt: 0.1,
        trackLoudAt: 9,

        mic: !('mic_off' in queries),
        micBeatAt: 1,
        micLoudAt: 5
    };

    const audioState = {...audioDefaults};


    const gl = glContext(canvas, glSettings, () => {
            tendrils.draw();

            gl.viewport(0, 0, ...tendrils.flow.shape);

            tendrils.flow.bind();
            Object.assign(flowInput.line.uniforms, tendrils.state);

            // @todo Kill old flow lines once empty
            flowInput
                .trimOld((1/tendrils.state.flowDecay)+100, tendrils.timer.now())
                .update().draw();


            // React to sound

            let soundInput = null;

            if(audioState.track && trackAnalyser && trackOrderLog) {
                trackAnalyser.frequencies(step(trackOrderLog[0]));
                orderLogRates(trackOrderLog, tendrils.timer.dt);

                if(mean(trackOrderLog[trackOrderLog.length-1][0]) >
                        audioState.trackBeatAt) {
                    soundInput = respawnCam;
                    console.log('track beat');
                }
                else if(sum(trackOrderLog[1][0]) > audioState.trackLoudAt) {
                    soundInput = respawnFlow;
                    console.log('track volume');
                }
            }

            if(!soundInput && audioState.mic && micAnalyser && micOrderLog) {
                micAnalyser.frequencies(step(micOrderLog[0]));
                orderLogRates(micOrderLog, tendrils.timer.dt);

                const beats = micOrderLog[micOrderLog.length-1][0];

                if(weightedMean(beats, beats.length*0.2) >
                        audioState.micBeatAt) {
                    soundInput = respawnCam;
                    console.log('mic beat');
                }
                else if(peak(micOrderLog[1][0]) > audioState.micLoudAt) {
                    soundInput = respawnFlow();
                    console.log('mic volume');
                }
            }

            if(soundInput) {
                soundInput();
            }
        });

    tendrils = new Tendrils(gl);

    const resetSpawner = spawnReset(gl);

    const respawn = () => resetSpawner.respawn(tendrils);

    const state = tendrils.state;


    // Flow line

    // @todo New flow lines for new pointers
    flowInput = new FlowLine(gl);

    const pointerFlow = (e) => {
        flowInput.times.push(tendrils.timer.now());

        const flow = offset(e, canvas, vec2.create());

        flow[0] = mapRange(flow[0], 0, tendrils.viewRes[0], -1, 1);
        flow[1] = mapRange(flow[1], 0, tendrils.viewRes[1], 1, -1);

        flowInput.line.path.push(flow);
    };

    canvas.addEventListener('pointermove', pointerFlow, false);


    // Feedback loop from flow
    /**
     * @todo The aspect ratio might be wrong here - always seems to converge on
     *       horizontal/vertical lines, like it were stretched.
     */

    const flowPixelSpawner = new spawnPixels.SpawnPixels(gl, {
            shader: [spawnPixels.defaults().shader[0], spawnPixelsFlowFrag],
            buffer: tendrils.flow
        });

    const flowPixelScales = {
        'normal': [1, -1],
        // This flips the lookup, which is interesting (reflection)
        'mirror x': [-1, -1],
        'mirror y': [1, 1],
        'mirror xy': [-1, 1],
    };

    const flowPixelDefaults = {
        scale: 'normal'
    };
    const flowPixelState = {...flowPixelDefaults};

    function respawnFlow() {
        vec2.div(flowPixelSpawner.spawnSize,
            flowPixelScales[flowPixelState.scale], tendrils.viewSize);

        flowPixelSpawner.respawn(tendrils);
    }


    // Spawn on fastest particles.

    const simplePixelSpawner = new spawnPixels.SpawnPixels(gl, {
            shader: [spawnPixels.defaults().shader[0], spawnPixelsSimpleFrag],
            buffer: null
        });

    function respawnFastest() {
        simplePixelSpawner.buffer = tendrils.particles.buffers[0];
        simplePixelSpawner.spawnSize = tendrils.particles.shape;
        simplePixelSpawner.respawn(tendrils);
    }


    // Cam

    const camPixelSpawner = new spawnPixels.SpawnPixels(gl);

    let video = null;

    function respawnCam() {
        if(video) {
            camPixelSpawner.setPixels(video);
            camPixelSpawner.respawn(tendrils);
        }
    }

    function respawnVideo() {
        camPixelSpawner.buffer.shape = [video.videoWidth, video.videoHeight];
        mat3.scale(camPixelSpawner.spawnMatrix,
            camPixelSpawner.spawnMatrix, [-1, 1]);
    }

    getUserMedia({
            video: true,
            audio: true
        },
        (e, stream) => {
            if(e) {
                throw e;
            }
            else {
                video = document.createElement('video');

                video.muted = true;
                video.src = self.URL.createObjectURL(stream);
                video.play();
                video.addEventListener('canplay', respawnVideo);


                // Trying out audio analyser.

                micAnalyser = analyser(stream, {
                        audible: false
                    });

                micAnalyser.analyser.fftSize = Math.pow(2, 8);

                const order = 2;

                micOrderLog = makeOrderLog(order, (size) =>
                    makeLog(size, () => makeAudioData(micAnalyser,
                        ((size === order)? Uint8Array : Float32Array))));
            }
        });


    // Track setup

    const setupTrack = (src, el = document.body) => {
        let track = Object.assign(new Audio(), {
                crossOrigin: 'Anonymous',
                src: src,
                controls: true
            });

        // @todo Stereo: true

        trackAnalyser = analyser(track, {
                audible: audioState.audible
            });

        trackAnalyser.analyser.fftSize = Math.pow(2, 5);

        const order = 3;

        trackOrderLog = makeOrderLog(order, (size) =>
            makeLog(size, () => makeAudioData(trackAnalyser,
                ((size === order)? Uint8Array : Float32Array))));

        track.play();
        el.appendChild(track);

        return track;
    };

    if(audioState.trackURL.match(/^(https?)?(\:\/\/)?(www\.)?soundcloud\.com\//gi)) {
        soundCloud({
                client_id: '75aca2e2b815f9f5d4e92916c7b80846',
                song: audioState.trackURL,
                dark: false
            },
            (e, src, data, el) => {
                if(e) {
                    throw e;
                }
                else {
                    setupTrack(src, el.querySelector('.npm-scb-info'));
                }
            });
    }
    else {
        setupTrack(audioState.trackURL, canvas.parentElement);
    }


    // Keyboard mash!

    document.body.addEventListener('keydown', (e) => {
            const key = vkey[e.keyCode];

            if(key.match(/^<escape>$/)) {
                tendrils.reset();
            }
            else if(key.match(/^<space>$/)) {
                respawnCam();
            }
            else if(key.match(/^[A-Z]$/)) {
                respawnFlow();
            }
            else if(key.match(/^[0-9]$/)) {
                respawnFastest();
            }
            else {
                respawn();
            }
        },
        false);


    function resize() {
        canvas.width = self.innerWidth;
        canvas.height = self.innerHeight;
    }

    self.addEventListener('resize', throttle(resize, 200), false);

    resize();


    tendrils.setup();
    tendrils.resetParticles();
    resetSpawner.respawn(tendrils);


    if(debug) {
        const gui = new dat.GUI();

        gui.close();

        function updateGUI(node = gui) {
            if(node.__controllers) {
                node.__controllers.forEach((control) => control.updateDisplay());
            }

            for(let f in node.__folders) {
                updateGUI(node.__folders[f]);
            }
        }

        function restart() {
            tendrils.clear();
            resetSpawner.respawn(tendrils)
        }


        // Settings


        let settingsGUI = gui.addFolder('settings');

        for(let s in state) {
            if(!(typeof state[s]).match(/(object|array)/gi)) {
                let control = settingsGUI.add(state, s);

                // Some special cases

                if(s === 'rootNum') {
                    control.onFinishChange((n) => {
                        tendrils.setup(n);
                        restart();
                    });
                }

                if(s === 'respawnAmount') {
                    control.onFinishChange((n) => {
                        tendrils.setupRespawn(state.rootNum, n);
                        tendrils.setupSpawnCache();
                    });
                }
            }
        }


        // DAT.GUI's color controllers are a bit fucked.

        const colorDefaults = {
                color: state.color.slice(0, 3).map((c) => c*255),
                alpha: state.color[3],

                baseColor: state.baseColor.slice(0, 3).map((c) => c*255),
                baseAlpha: state.baseColor[3]
            };

        let colorGUI = {...colorDefaults};

        const convertColor = () => Object.assign(state, {
            color: [...colorGUI.color.map((c) => c/255), colorGUI.alpha],
            baseColor: [...colorGUI.baseColor.map((c) => c/255), colorGUI.baseAlpha]
        });

        settingsGUI.addColor(colorGUI, 'color').onChange(convertColor);
        settingsGUI.add(colorGUI, 'alpha').onChange(convertColor);

        settingsGUI.addColor(colorGUI, 'baseColor').onChange(convertColor);
        settingsGUI.add(colorGUI, 'baseAlpha').onChange(convertColor);

        convertColor();


        // Respawn

        let respawnGUI = gui.addFolder('respawn');

        for(let s in resetSpawner.uniforms) {
            if(!(typeof resetSpawner.uniforms[s]).match(/(object|array)/gi)) {
                respawnGUI.add(resetSpawner.uniforms, s);
            }
        }

        const resetSpawnerDefaults = {
            radius: 0.3,
            speed: 0.005
        };

        respawnGUI.add(flowPixelState, 'scale', Object.keys(flowPixelScales));


        // Audio

        let audioGUI = gui.addFolder('audio');

        for(let s in audioState) {
            let control = audioGUI.add(audioState, s);

            if(s === 'trackURL') {
                control.onFinishChange((v) =>
                    location.search = querystring.encode({
                            ...queries,
                            track: encodeURIComponent(v)
                        }));
            }

            if(s === 'audible') {
                control.onChange((v) => {
                    const out = (trackAnalyser.merger || trackAnalyser.analyser);

                    if(v) {
                        out.connect(trackAnalyser.ctx.destination);
                    }
                    else {
                        out.disconnect();
                    }
                });
            }
        }


        // Controls

        let controllers = {
                cyclingColor: false,

                clear: () => tendrils.clear(),
                clearView: () => tendrils.clearView(),
                clearFlow: () => tendrils.clearFlow(),
                respawn,
                respawnCam,
                respawnFlow,
                respawnFastest,
                reset: () => tendrils.reset(),
                restart
            };


        let controlsGUI = gui.addFolder('controls');

        for(let c in controllers) {
            controlsGUI.add(controllers, c);
        }


        const cycleColor = () => {
            if(controllers.cyclingColor) {
                Object.assign(colorGUI, {
                    alpha: 0.2,
                    color: [
                        Math.sin(Date.now()*0.009)*200,
                        100+Math.sin(Date.now()*0.006)*155,
                        200+Math.sin(Date.now()*0.003)*55
                    ]
                });

                convertColor();
            }

            requestAnimationFrame(cycleColor);
        }

        cycleColor();


        // Presets

        let presetsGUI = gui.addFolder('presets');

        let presetters = {
            'Flow'() {
                Object.assign(state, {
                        showFlow: true,
                        flowWidth: 5
                    });

                Object.assign(resetSpawner.uniforms, {
                        radius: 0.25,
                        speed: 0.01
                    });

                Object.assign(colorGUI, {
                        alpha: 0.01,
                        color: [255, 255, 255]
                    });
            },
            'Wings'() {
                Object.assign(state, {
                        showFlow: false
                    });

                Object.assign(resetSpawner.uniforms, {
                        radius: 0.1,
                        speed: 0
                    });

                Object.assign(colorGUI);
            },
            'Fluid'() {
                Object.assign(state, {
                        autoClearView: true,
                        showFlow: false
                    });

                Object.assign(colorGUI, {
                        alpha: 0.2,
                        color: [255, 255, 255]
                    });
            },
            'Flow only'() {
                Object.assign(state, {
                        showFlow: false,
                        autoClearView: false,
                        flowDecay: 0.0005,
                        forceWeight: 0.015,
                        wanderWeight: 0,
                        speedAlpha: 0,
                        respawnAmount: 0.03,
                    });

                Object.assign(resetSpawner.uniforms, {
                        radius: 0.25,
                        speed: 0.015
                    });

                Object.assign(colorGUI, {
                        alpha: 0.8,
                        color: [100, 200, 255],
                        baseAlpha: 0.1,
                        baseColor: [0, 0, 0]
                    });
            },
            'Noise only'() {
                Object.assign(state, {
                        autoClearView: false,
                        showFlow: false,
                        flowWeight: 0,
                        wanderWeight: 0.002,
                        noiseSpeed: 0,
                        speedAlpha: 0
                    });

                Object.assign(colorGUI, {
                        alpha: 0.01,
                        color: [255, 150, 0]
                    });
            },
            'Sea'() {
                Object.assign(state, {
                        showFlow: false,
                        flowWidth: 5,
                        forceWeight: 0.015,
                        wanderWeight: 0.0014,
                        flowDecay: 0.001,
                        fadeAlpha: 10,
                        speedAlpha: 0
                    });

                Object.assign(resetSpawner.uniforms, {
                        radius: 1,
                        speed: 0
                    });

                Object.assign(colorGUI, {
                        alpha: 0.8,
                        color: [55, 155, 255]
                    });
            },
            'Mad styles'() {
                Object.assign(state, {
                        showFlow: false
                    });

                Object.assign(colorGUI);

                controllers.cyclingColor = true;
            },
            'Ghostly'() {
                Object.assign(state, {
                        showFlow: false,
                        autoClearView: false,
                        flowDecay: 0
                    });

                Object.assign(colorGUI, {
                        alpha: 0.006,
                        color: [255, 255, 255]
                    });
            },
            'Turbulence'() {
                Object.assign(state, {
                        showFlow: false,
                        autoClearView: false,
                        noiseSpeed: 0.00001,
                        noiseScale: 18,
                        forceWeight: 0.014,
                        wanderWeight: 0.0021,
                        speedAlpha: 0.000002
                    });

                Object.assign(colorGUI, {
                        alpha: 0.9,
                        color: [255, 10, 10],
                        baseAlpha: 0.01,
                        baseColor: [0, 0, 0]
                    });
            },
            'Rorschach'() {
                Object.assign(state, {
                        showFlow: false,
                        autoClearView: false,
                        noiseSpeed: 0.00001,
                        noiseScale: 60,
                        forceWeight: 0.014,
                        wanderWeight: 0.0021,
                        speedAlpha: 0.000002
                    });

                Object.assign(flowPixelState, {
                    scale: 'mirror xy'
                });

                Object.assign(colorGUI, {
                        alpha: 1,
                        color: [0, 0, 0],
                        baseAlpha: 0.01,
                        baseColor: [255, 255, 255]
                    });
            },
            'Roots'() {
                Object.assign(state, {
                        showFlow: false,
                        autoClearView: false,
                        flowDecay: 0,
                        noiseSpeed: 0,
                        noiseScale: 18,
                        forceWeight: 0.015,
                        wanderWeight: 0.0023,
                        speedAlpha: 0.00005,
                        lineWidth: 3
                    });

                Object.assign(colorGUI, {
                        alpha: 0.03,
                        color: [50, 255, 50]
                    });
            },
            'Hairy'() {
                Object.assign(state, {
                        showFlow: false,
                        autoClearView: false,
                        timeStep: 1000/60,
                        flowDecay: 0.001,
                        wanderWeight: 0.002,
                        speedAlpha: 0
                    });

                Object.assign(colorGUI, {
                        alpha: 0.9,
                        color: [255, 150, 255],
                        baseAlpha: 0.005,
                        baseColor: [0, 0, 0]
                    });
            }
        };

        const wrapPresetter = (presetter) => {
            Object.assign(state, defaultSettings);
            Object.assign(resetSpawner.uniforms, resetSpawnerDefaults);
            Object.assign(flowPixelState, flowPixelDefaults);
            Object.assign(colorGUI, colorDefaults);
            controllers.cyclingColor = false;

            presetter();

            controllers.restart();
            updateGUI();
            convertColor();
        };

        for(let p in presetters) {
            presetters[p] = wrapPresetter.bind(null, presetters[p]);
            presetsGUI.add(presetters, p);
        }

        presetters['Flow']();
    }
};
