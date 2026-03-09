import './displace.css'
import { createProgram, createFullscreenQuad, perspective, lookAt, mat4Multiply } from './webgl.js'
import { setupRecording } from './controls.js'
import terrainVert from './shaders/displace/terrain-vert.glsl'
import terrainFrag from './shaders/displace/terrain-frag.glsl'
import fullscreenVert from './shaders/vertex.glsl'
import twistFrag from './shaders/displace/twist.glsl'
import timesliceFrag from './shaders/displace/timeslice.glsl'

const canvas = document.querySelector('#canvas')
const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true })

if (!gl) {
    document.body.innerHTML = '<p style="color:white;padding:20px;">WebGL not supported</p>'
    throw new Error('WebGL not supported')
}

// --- Subdivided plane geometry (for terrain) ---

const GRID = 128

function createSubdividedPlane(gl, program) {
    const verts = (GRID + 1) * (GRID + 1)
    const positions = new Float32Array(verts * 3)
    const uvs = new Float32Array(verts * 2)

    for (let row = 0; row <= GRID; row++) {
        for (let col = 0; col <= GRID; col++) {
            const i = row * (GRID + 1) + col
            const u = col / GRID
            const v = row / GRID
            positions[i * 3] = (u - 0.5) * 2
            positions[i * 3 + 1] = 0
            positions[i * 3 + 2] = (v - 0.5) * 2
            uvs[i * 2] = u
            uvs[i * 2 + 1] = v
        }
    }

    const indices = new Uint16Array(GRID * GRID * 6)
    let idx = 0
    for (let row = 0; row < GRID; row++) {
        for (let col = 0; col < GRID; col++) {
            const tl = row * (GRID + 1) + col
            const tr = tl + 1
            const bl = (row + 1) * (GRID + 1) + col
            const br = bl + 1
            indices[idx++] = tl
            indices[idx++] = bl
            indices[idx++] = tr
            indices[idx++] = tr
            indices[idx++] = bl
            indices[idx++] = br
        }
    }

    const posBuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)
    const posLoc = gl.getAttribLocation(program, 'a_position')
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0)

    const uvBuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf)
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW)
    const uvLoc = gl.getAttribLocation(program, 'a_uv')
    gl.enableVertexAttribArray(uvLoc)
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0)

    const indexBuf = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)

    return { indexCount: indices.length, posBuf, uvBuf, indexBuf }
}

// --- Programs ---

const terrainProgram = createProgram(gl, terrainVert, terrainFrag)
if (!terrainProgram) throw new Error('Failed to create terrain program')

const twistProgram = createProgram(gl, fullscreenVert, twistFrag)
if (!twistProgram) throw new Error('Failed to create twist program')

const terrainUniforms = {
    mvp: gl.getUniformLocation(terrainProgram, 'u_mvp'),
    time: gl.getUniformLocation(terrainProgram, 'u_time'),
    displacement: gl.getUniformLocation(terrainProgram, 'u_displacement'),
    noiseScale: gl.getUniformLocation(terrainProgram, 'u_noiseScale'),
    speed: gl.getUniformLocation(terrainProgram, 'u_speed'),
    texture: gl.getUniformLocation(terrainProgram, 'u_texture'),
    hasTexture: gl.getUniformLocation(terrainProgram, 'u_hasTexture'),
}

const twistUniforms = {
    time: gl.getUniformLocation(twistProgram, 'u_time'),
    texture: gl.getUniformLocation(twistProgram, 'u_texture'),
    resolution: gl.getUniformLocation(twistProgram, 'u_resolution'),
    hasTexture: gl.getUniformLocation(twistProgram, 'u_hasTexture'),
    twistSpeed: gl.getUniformLocation(twistProgram, 'u_twistSpeed'),
    twistAmount: gl.getUniformLocation(twistProgram, 'u_twistAmount'),
}

const timesliceProgram = createProgram(gl, fullscreenVert, timesliceFrag)
if (!timesliceProgram) throw new Error('Failed to create timeslice program')

const timesliceUniforms = {
    texture: gl.getUniformLocation(timesliceProgram, 'u_texture'),
    resolution: gl.getUniformLocation(timesliceProgram, 'u_resolution'),
    hasTexture: gl.getUniformLocation(timesliceProgram, 'u_hasTexture'),
    mode: gl.getUniformLocation(timesliceProgram, 'u_mode'),
    writePtr: gl.getUniformLocation(timesliceProgram, 'u_writePtr'),
    tileCount: gl.getUniformLocation(timesliceProgram, 'u_tileCount'),
    gridSize: gl.getUniformLocation(timesliceProgram, 'u_gridSize'),
    depth: gl.getUniformLocation(timesliceProgram, 'u_depth'),
}

// --- Atlas ring buffer for timeslice ---

const ATLAS_GRID = 8         // 8x8 grid
const TILE_COUNT = ATLAS_GRID * ATLAS_GRID  // 64 tiles
const TILE_SIZE = 256        // pixels per tile
const ATLAS_SIZE = ATLAS_GRID * TILE_SIZE   // 2048

// Atlas texture: stores all history tiles
const atlasTexture = gl.createTexture()
gl.bindTexture(gl.TEXTURE_2D, atlasTexture)
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ATLAS_SIZE, ATLAS_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

// Tile FBO: renders video at tile resolution, then copies into atlas
const tileFBOTex = gl.createTexture()
gl.bindTexture(gl.TEXTURE_2D, tileFBOTex)
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TILE_SIZE, TILE_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

const tileFBO = gl.createFramebuffer()
gl.bindFramebuffer(gl.FRAMEBUFFER, tileFBO)
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tileFBOTex, 0)
gl.bindFramebuffer(gl.FRAMEBUFFER, null)

let atlasWritePtr = 0
let lastTime = 0

// --- Effect state ---

let currentEffect = 'terrain'
let mesh = null

// Set up terrain geometry
gl.useProgram(terrainProgram)
mesh = createSubdividedPlane(gl, terrainProgram)

// --- UI elements ---

const dropZone = document.querySelector('#drop-zone')
const fileInput = document.querySelector('#file-input')
const urlInput = document.querySelector('#url-input')
const loadUrlBtn = document.querySelector('#load-url')
const loadingEl = document.querySelector('#loading')
const displacementSlider = document.querySelector('#displacement')
const noiseScaleSlider = document.querySelector('#noiseScale')
const speedSlider = document.querySelector('#speed')
const twistSpeedSlider = document.querySelector('#twistSpeed')
const twistAmountSlider = document.querySelector('#twistAmount')
const timeDepthSlider = document.querySelector('#timeDepth')
const terrainSliders = document.querySelector('#sliders')
const twistSliders = document.querySelector('#twist-sliders')
const timesliceSliders = document.querySelector('#timeslice-sliders')

// --- Texture state ---

let imageTexture = null
let hasTexture = false
let videoSource = null

const recorder = setupRecording(canvas)

// Create/replace the GL texture object
function initTexture() {
    if (imageTexture) gl.deleteTexture(imageTexture)
    videoSource = null

    imageTexture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, imageTexture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
}

function loadTextureFromImage(image) {
    initTexture()
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    hasTexture = true
    loadingEl.classList.add('hidden')
}

function loadTextureFromVideo(video) {
    initTexture()
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
    hasTexture = true
    videoSource = video
    loadingEl.classList.add('hidden')
}

function loadMediaFile(file) {
    if (file.type.startsWith('video/')) {
        loadingEl.classList.remove('hidden')
        const video = document.createElement('video')
        video.muted = true
        video.loop = true
        video.playsInline = true
        video.src = URL.createObjectURL(file)
        video.addEventListener('loadeddata', () => {
            video.play()
            loadTextureFromVideo(video)
        })
        video.addEventListener('error', () => {
            alert('Failed to load video')
            loadingEl.classList.add('hidden')
        })
        return
    }

    if (!file.type.startsWith('image/')) {
        alert('Please select an image or video file')
        return
    }

    loadingEl.classList.remove('hidden')
    const reader = new FileReader()
    reader.onload = (e) => {
        const img = new Image()
        img.onload = () => loadTextureFromImage(img)
        img.onerror = () => { alert('Failed to load image'); loadingEl.classList.add('hidden') }
        img.src = e.target.result
    }
    reader.readAsDataURL(file)
}

function loadMediaUrl(url) {
    if (!url) return

    const videoExts = /\.(mp4|webm|ogv|mov)(\?|$)/i
    if (videoExts.test(url)) {
        loadingEl.classList.remove('hidden')
        const video = document.createElement('video')
        video.muted = true
        video.loop = true
        video.playsInline = true
        video.crossOrigin = 'anonymous'
        video.src = url
        video.addEventListener('loadeddata', () => {
            video.play()
            loadTextureFromVideo(video)
        })
        video.addEventListener('error', () => {
            alert('Failed to load video from URL')
            loadingEl.classList.add('hidden')
        })
        return
    }

    loadingEl.classList.remove('hidden')
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => loadTextureFromImage(img)
    img.onerror = () => { alert('Failed to load image from URL'); loadingEl.classList.add('hidden') }
    img.src = url
}

// --- Effect switching ---

function switchEffect(name) {
    currentEffect = name

    // Show/hide appropriate sliders
    terrainSliders.style.display = name === 'terrain' ? '' : 'none'
    twistSliders.style.display = name === 'twist' ? '' : 'none'
    timesliceSliders.style.display = name === 'timeslice' ? '' : 'none'

    // Set up geometry for the active effect
    if (name === 'twist') {
        gl.useProgram(twistProgram)
        createFullscreenQuad(gl, twistProgram)
        gl.uniform2f(twistUniforms.resolution, canvas.width, canvas.height)
    } else if (name === 'timeslice') {
        gl.useProgram(timesliceProgram)
        createFullscreenQuad(gl, timesliceProgram)
        atlasWritePtr = 0
    } else {
        gl.useProgram(terrainProgram)
        mesh = createSubdividedPlane(gl, terrainProgram)
    }

    document.querySelectorAll('#controls button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.effect === name)
    })
}

// --- Event listeners ---

document.querySelectorAll('#controls button').forEach(btn => {
    btn.addEventListener('click', () => switchEffect(btn.dataset.effect))
})

dropZone.addEventListener('click', () => fileInput.click())
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover') })
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'))
dropZone.addEventListener('drop', (e) => {
    e.preventDefault(); dropZone.classList.remove('dragover')
    const file = e.dataTransfer.files[0]
    if (file) loadMediaFile(file)
})
fileInput.addEventListener('change', (e) => { const file = e.target.files[0]; if (file) loadMediaFile(file) })
loadUrlBtn.addEventListener('click', () => loadMediaUrl(urlInput.value))
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadMediaUrl(urlInput.value) })

document.addEventListener('keydown', (e) => {
    if (e.key === '1') switchEffect('terrain')
    if (e.key === '2') switchEffect('twist')
    if (e.key === '3') switchEffect('timeslice')
    if (e.key === 'r' || e.key === 'R') recorder.toggle()
})

// --- Resize ---

function resize() {
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight
    gl.viewport(0, 0, canvas.width, canvas.height)

    if (currentEffect === 'twist') {
        gl.useProgram(twistProgram)
        gl.uniform2f(twistUniforms.resolution, canvas.width, canvas.height)
    }
}

window.addEventListener('resize', resize)
resize()

// --- Render ---

gl.enable(gl.DEPTH_TEST)

function render(time) {
    const t = time * 0.001
    const dt = t - lastTime
    lastTime = t

    gl.clearColor(0.05, 0.05, 0.1, 1.0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    // Update video texture each frame
    if (hasTexture && imageTexture && videoSource && !videoSource.paused) {
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, imageTexture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoSource)
    }

    if (currentEffect === 'terrain') {
        gl.useProgram(terrainProgram)
        mesh = createSubdividedPlane(gl, terrainProgram)

        const camDist = 2.2
        const camAngle = t * 0.1
        const eye = [
            Math.sin(camAngle) * camDist,
            1.2,
            Math.cos(camAngle) * camDist,
        ]
        const proj = perspective(Math.PI / 4, canvas.width / canvas.height, 0.1, 100)
        const view = lookAt(eye, [0, 0, 0], [0, 1, 0])
        const mvp = mat4Multiply(proj, view)

        gl.uniformMatrix4fv(terrainUniforms.mvp, false, mvp)
        gl.uniform1f(terrainUniforms.time, t)
        gl.uniform1f(terrainUniforms.displacement, parseFloat(displacementSlider.value))
        gl.uniform1f(terrainUniforms.noiseScale, parseFloat(noiseScaleSlider.value))
        gl.uniform1f(terrainUniforms.speed, parseFloat(speedSlider.value))
        gl.uniform1i(terrainUniforms.hasTexture, hasTexture ? 1 : 0)

        if (hasTexture && imageTexture) {
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, imageTexture)
            gl.uniform1i(terrainUniforms.texture, 0)
        }

        gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0)
    } else if (currentEffect === 'twist') {
        gl.useProgram(twistProgram)
        createFullscreenQuad(gl, twistProgram)

        gl.uniform1f(twistUniforms.time, t)
        gl.uniform2f(twistUniforms.resolution, canvas.width, canvas.height)
        gl.uniform1i(twistUniforms.hasTexture, hasTexture ? 1 : 0)
        gl.uniform1f(twistUniforms.twistSpeed, parseFloat(twistSpeedSlider.value))
        gl.uniform1f(twistUniforms.twistAmount, parseFloat(twistAmountSlider.value))

        if (hasTexture && imageTexture) {
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, imageTexture)
            gl.uniform1i(twistUniforms.texture, 0)
        }

        gl.disable(gl.DEPTH_TEST)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        gl.enable(gl.DEPTH_TEST)
    } else if (currentEffect === 'timeslice') {
        gl.disable(gl.DEPTH_TEST)

        gl.useProgram(timesliceProgram)
        createFullscreenQuad(gl, timesliceProgram)

        if (hasTexture) {
            // Pass 1: Capture — render video into tile FBO at tile resolution
            gl.bindFramebuffer(gl.FRAMEBUFFER, tileFBO)
            gl.viewport(0, 0, TILE_SIZE, TILE_SIZE)

            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, imageTexture)
            gl.uniform1i(timesliceUniforms.texture, 0)
            gl.uniform2f(timesliceUniforms.resolution, TILE_SIZE, TILE_SIZE)
            gl.uniform1i(timesliceUniforms.mode, 0)

            gl.drawArrays(gl.TRIANGLES, 0, 6)

            // Copy tile FBO into atlas at writePtr position
            const tileCol = atlasWritePtr % ATLAS_GRID
            const tileRow = Math.floor(atlasWritePtr / ATLAS_GRID)
            const destX = tileCol * TILE_SIZE
            const destY = tileRow * TILE_SIZE

            gl.bindTexture(gl.TEXTURE_2D, atlasTexture)
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, destX, destY, 0, 0, TILE_SIZE, TILE_SIZE)

            // Pass 2: Display — render atlas to screen
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
            gl.viewport(0, 0, canvas.width, canvas.height)

            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, atlasTexture)
            gl.uniform1i(timesliceUniforms.texture, 0)
            gl.uniform2f(timesliceUniforms.resolution, canvas.width, canvas.height)
            gl.uniform1i(timesliceUniforms.mode, 1)
            gl.uniform1i(timesliceUniforms.hasTexture, 1)
            gl.uniform1f(timesliceUniforms.writePtr, atlasWritePtr)
            gl.uniform1f(timesliceUniforms.tileCount, TILE_COUNT)
            gl.uniform1f(timesliceUniforms.gridSize, ATLAS_GRID)
            gl.uniform1f(timesliceUniforms.depth, parseFloat(timeDepthSlider.value))

            gl.drawArrays(gl.TRIANGLES, 0, 6)

            // Advance write pointer
            atlasWritePtr = (atlasWritePtr + 1) % TILE_COUNT
        } else {
            // No texture: show placeholder
            gl.uniform2f(timesliceUniforms.resolution, canvas.width, canvas.height)
            gl.uniform1i(timesliceUniforms.hasTexture, 0)
            gl.uniform1i(timesliceUniforms.mode, 1)
            gl.drawArrays(gl.TRIANGLES, 0, 6)
        }

        gl.enable(gl.DEPTH_TEST)
    }

    requestAnimationFrame(render)
}

requestAnimationFrame(render)
