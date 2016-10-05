import shader from 'gl-shader';
import FBO from 'gl-fbo';

import Particles from './particles';
import Timer from './timer';
import { step/*, nextPow2*/ } from '../utils';
import spawner from './spawn/init/cpu';
import { maxAspect } from './utils/aspect';

import Screen from './screen';


// Shaders

import logicFrag from './logic.frag';

import renderVert from './render/index.vert';
import renderFrag from './render/index.frag';

import flowVert from './flow/index.vert';
import flowScreenVert from './flow/screen.vert';
import flowFrag from './flow/index.frag';

import screenVert from './screen/index.vert';
import screenFrag from './screen/index.frag';

// @todo Try drawing a semi-transparent block over the last frame?
import copyFadeFrag from './screen/copy-fade.frag';


export const defaults = () => ({
    state: {
        rootNum: Math.pow(2, 9),

        autoClearView: false,
        showFlow: false,

        damping: 0.045,
        minSpeed: 0.000001,
        maxSpeed: 0.01,

        forceWeight: 0.015,
        flowWeight: 1,
        wanderWeight: 0.001,

        flowDecay: 0.0005,
        flowWidth: 5,

        noiseScale: 2.125,
        noiseSpeed: 0.00025,

        // @todo Make this a texture lookup instead
        color: [1, 1, 1, 0.05],
        // @todo Move this to another module, doesn't need to be here
        baseColor: [0, 0, 0, 0],

        fadeAlpha: -1,
        speedAlpha: 0.000001,
        lineWidth: 1
    },
    timer: Object.assign(new Timer(), {
            step: 1000/60
        }),
    logicShader: null,
    renderShader: [renderVert, renderFrag],
    flowShader: [flowVert, flowFrag],
    flowScreenShader: [flowScreenVert, flowFrag],
    fadeShader: [screenVert, copyFadeFrag]
});

export const glSettings = {
    preserveDrawingBuffer: true
};


export class Tendrils {
    constructor(gl, options) {
        const params = {
            ...defaults(),
            ...options
        };

        this.gl = gl;
        this.state = params.state;

        this.screen = new Screen(this.gl);

        this.flow = FBO(this.gl, [1, 1], { float: true });

        // Multiple bufferring
        /**
         * @todo May need more buffers/passes later?
         */
        this.buffers = [
            FBO(this.gl, [1, 1]),
            FBO(this.gl, [1, 1])
        ];

        this.baseShader = shader(this.gl, screenVert, screenFrag);

        this.logicShader = null;

        this.renderShader = ((Array.isArray(params.renderShader))?
                shader(this.gl, ...params.renderShader)
            :   params.renderShader);

        this.flowShader = ((Array.isArray(params.flowShader))?
                shader(this.gl, ...params.flowShader)
            :   params.flowShader);

        this.flowScreenShader = ((Array.isArray(params.flowScreenShader))?
                shader(this.gl, ...params.flowScreenShader)
            :   params.flowScreenShader);

        this.fadeShader = ((Array.isArray(params.fadeShader))?
                shader(this.gl, ...params.fadeShader)
            :   params.fadeShader);

        this.uniforms = {
                render: {},
                update: {}
            };


        this.particles = null;

        this.viewRes = [0, 0];
        // this.pow2Res = [0, 0];

        this.viewSize = [0, 0];

        this.timer = params.timer;

        this.tempData = [];

        this.respawnOffset = [0, 0];
        this.respawnShape = [0, 0];

        this.spawnCache = null;
        this.spawnCacheOffset = 0;
    }

    setup(...rest) {
        this.setupParticles(...rest);
        this.reset();
    }

    reset() {
        this.respawn();
    }

    // @todo
    dispose() {
        this.particles.dispose();

        delete this.particles;
        delete this.spawnCache;
    }


    setupParticles(rootNum = this.state.rootNum) {
        const shape = [rootNum, rootNum];

        this.particles = new Particles(this.gl, {
                shape,

                // Double the rootNum of (vertical neighbour) vertices, to have
                // pairs alternating between previous and current state.
                // (Vertical neighbours, because WebGL iterates column-major.)
                geomShape: [shape[0], shape[1]*2],

                logicFrag: logicFrag,
                render: this.renderShader
            });

        this.logicShader = this.particles.logic;

        this.particles.setup(this.state.numBuffers || 2);
    }


    // Rendering and logic

    clear() {
        this.clearView();
        this.clearFlow();
    }

    clearView() {
        this.buffers.forEach((buffer) => {
            buffer.bind();
            this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        });

        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }

    clearFlow() {
        this.flow.bind();
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }

    restart() {
        this.clear();
        this.reset();
    }

    draw() {
        const directDraw = this.directDraw();

        this.resize(directDraw);


        // Physics

        if(!this.timer.paused) {
            this.particles.logic = this.logicShader;

            // Disabling blending here is important
            this.gl.disable(this.gl.BLEND);

            Object.assign(this.uniforms.update, this.state, {
                    dt: this.timer.dt,
                    time: this.timer.time,
                    start: this.timer.since,
                    flow: this.flow.color[0].bind(1),
                    viewSize: this.viewSize,
                    viewRes: this.viewRes
                });

            this.particles.step(this.uniforms.update);

            this.gl.enable(this.gl.BLEND);
            this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
        }


        // Flow FBO and view renders

        Object.assign(this.uniforms.render, this.state, {
                time: this.timer.time,
                previous: this.particles.buffers[1].color[0].bind(2),
                dataRes: this.particles.shape,
                viewSize: this.viewSize,
                viewRes: this.viewRes
            });

        this.particles.render = this.flowShader;

        // Render to the flow FBO - after the logic render, so particles don't
        // respond to their own flow.

        this.flow.bind();

        this.gl.lineWidth(Math.max(0, this.state.flowWidth));
        this.particles.draw(this.uniforms.render, this.gl.LINES);

        /**
         * @todo Mipmaps for global flow sampling - not working at the moment.
         * @todo Instead of auto-generating mipmaps, should we re-render at each
         *       scale, with different opacities and line widths? This would
         *       mean the influence is spread out when drawing, instead of when
         *       sampling.
         */
        // this.flow.color[0].generateMipmap();


        // Render to the view.

        // Overlay fade.
        if(this.state.baseColor[3] > 0) {
            this.baseShader.bind();
            this.baseShader.uniforms.color = this.state.baseColor;
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
            this.screen.render();
        }

        // Show flow
        if(this.state.showFlow) {
            // @todo Surely just render the flow texture instead?
            this.particles.render = this.flowScreenShader;

            if(this.state.lineWidth > 0) {
                this.gl.lineWidth(Math.max(0, this.state.lineWidth));
            }

            // Render the flow directly to the screen
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
            this.particles.draw(this.uniforms.render, this.gl.LINES);
        }

        // Set up the particles for rendering
        this.particles.render = this.renderShader;
        this.gl.lineWidth(Math.max(0, this.state.lineWidth));

        if(directDraw) {
            // Render the particles directly to the screen

            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);

            if(this.state.autoClearView) {
                this.gl.clear(this.gl.COLOR_BUFFER_BIT);
            }

            this.particles.draw(this.uniforms.render, this.gl.LINES);
        }
        else {
            // Multi-buffer fade etc passes

            this.buffers[0].bind();
            this.gl.clear(this.gl.COLOR_BUFFER_BIT);

            // Copy and fade the last buffer into the current buffer

            this.fadeShader.bind();

            Object.assign(this.fadeShader.uniforms, {
                    opacity: this.state.fadeAlpha,
                    view: this.buffers[1].color[0].bind(1),
                    viewRes: this.viewRes
                });

            this.screen.render();


            // Render the particles into the current buffer
            this.particles.draw(this.uniforms.render, this.gl.LINES);


            // Copy and fade the current buffer to the screen

            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
            this.gl.clear(this.gl.COLOR_BUFFER_BIT);

            this.fadeShader.bind();

            Object.assign(this.fadeShader.uniforms, {
                    opacity: 1,
                    view: this.buffers[0].color[0].bind(2),
                    viewRes: this.viewRes
                });

            this.screen.render();

            // Step buffers
            step(this.buffers);
        }
    }

    resize(directDraw = this.directDraw()) {
        this.viewRes[0] = this.gl.drawingBufferWidth;
        this.viewRes[1] = this.gl.drawingBufferHeight;

        maxAspect(this.viewSize, this.viewRes);

        // this.pow2Res.fill(nextPow2(Math.max(...this.viewRes)));

        if(!directDraw) {
            this.buffers.forEach((buffer) => buffer.shape = this.viewRes);
        }

        // this.flow.shape = this.pow2Res;
        this.flow.shape = this.viewRes;

        /**
         * @todo Why do these 2 lines seem to be equivalent? Something to do
         *       with how `gl-big-triangle` scales its geometry over the screen?
         */
        // this.gl.viewport(0, 0, 1, 1);
        this.gl.viewport(0, 0, this.viewRes[0], this.viewRes[1]);
    }


    // @todo More specific, or derived from properties?
    directDraw(state = this.state) {
        return (state.autoClearView || state.fadeAlpha < 0);
    }


    // Respawn

    // Populate the particles with the given spawn function
    respawn(spawn = spawner) {
        this.particles.spawn(spawn);
    }

    // Respawn on the GPU using a given shader
    respawnShader(spawnShader, update) {
        this.resize(false);
        this.timer.tick();

        this.particles.logic = spawnShader;

        // Disabling blending here is important
        this.gl.disable(this.gl.BLEND);

        this.particles.step(Particles.applyUpdate({
                ...this.state,
                time: this.timer.time,
                viewSize: this.viewSize,
                viewRes: this.viewRes
            },
            update));

        this.particles.logic = this.logicShader;

        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    }
}


export default Tendrils;