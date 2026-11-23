// gpusample.js - read the brightness at many points of a video frame on the GPU (WebGL2).
// The video frame is uploaded as a texture; a fragment shader looks up one point per output
// pixel (positions come from a float texture) and only those values are read back. That avoids
// copying the whole camera picture into JavaScript, which is the slow part on phones.

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D video;
uniform highp sampler2D points;
uniform vec2 videoSize;
uniform int width;
out vec4 color;
void main() {
    ivec2 o = ivec2(gl_FragCoord.xy);
    vec2 pt = texelFetch(points, o, 0).xy;
    // the pixel the point falls in, sampled at its centre
    vec2 uv = (floor(pt) + 0.5) / videoSize;
    float g = texture(video, uv).g;
    color = vec4(g, g, g, 1.0);
}`;

export class GpuSampler {
    // points: Float32Array [x0, y0, x1, y1, ...] in video pixel coordinates
    constructor(points) {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
        if (!gl) throw new Error('WebGL2 not available');
        this.gl = gl;
        this.n = points.length / 2;
        this.w = 256;
        this.h = Math.ceil(this.n / this.w);
        canvas.width = this.w;
        canvas.height = this.h;

        const compile = (type, src) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
            return sh;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        gl.useProgram(prog);
        this.prog = prog;

        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, 'p');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

        // positions texture (RG32F)
        const pts = new Float32Array(this.w * this.h * 2);
        pts.set(points);
        this.pointsTex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.pointsTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, this.w, this.h, 0, gl.RG, gl.FLOAT, pts);

        // video texture
        this.videoTex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        gl.uniform1i(gl.getUniformLocation(prog, 'video'), 0);
        gl.uniform1i(gl.getUniformLocation(prog, 'points'), 1);
        gl.uniform1i(gl.getUniformLocation(prog, 'width'), this.w);
        this.sizeLoc = gl.getUniformLocation(prog, 'videoSize');
        gl.viewport(0, 0, this.w, this.h);
        this.pixels = new Uint8Array(this.w * this.h * 4);
    }

    // Brightness (0..255, green channel) at every point, as Float32Array
    sample(video) {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.uniform2f(this.sizeLoc, video.videoWidth, video.videoHeight);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
        const out = new Float32Array(this.n);
        for (let i = 0; i < this.n; i++) out[i] = this.pixels[i * 4 + 1];
        return out;
    }
}
