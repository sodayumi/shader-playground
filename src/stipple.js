import './style.css'
import { createProgram, createFullscreenQuad } from './webgl.js'
import { SliderManager, setupRecording } from './controls.js'
import vertexShader from './shaders/vertex.glsl'
import stippleShader from './shaders/stipple.glsl'

const canvas = document.querySelector('#canvas')
const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true })

if (!gl) {
    document.body.innerHTML = '<p style="color:white;padding:20px;">WebGL not supported</p>'
    throw new Error('WebGL not supported')
}

const program = createProgram(gl, vertexShader, stippleShader)
if (!program) throw new Error('Failed to create shader program')

gl.useProgram(program)
createFullscreenQuad(gl, program)

const uniforms = {
    resolution: gl.getUniformLocation(program, 'u_resolution'),
    time: gl.getUniformLocation(program, 'u_time'),
    video: gl.getUniformLocation(program, 'u_video'),
    videoSize: gl.getUniformLocation(program, 'u_videoSize'),
    dotDensity: gl.getUniformLocation(program, 'u_dotDensity'),
    dotScale: gl.getUniformLocation(program, 'u_dotScale'),
    contrast: gl.getUniformLocation(program, 'u_contrast'),
    showLines: gl.getUniformLocation(program, 'u_showLines'),
    invert: gl.getUniformLocation(program, 'u_invert'),
}

const sliders = new SliderManager({
    density:   { selector: '#density',   default: 1.0, uniform: 'dotDensity' },
    dotScale:  { selector: '#dotScale',  default: 1.0 },
    contrast:  { selector: '#contrast',  default: 1.5 },
    showLines: { selector: '#showLines', default: false, type: 'checkbox' },
    invert:    { selector: '#invert',    default: false, type: 'checkbox' },
})

const recorder = setupRecording(canvas, { keyboardShortcut: null })

// --- Video/Texture State ---
let videoTexture = null
let videoElement = null // This will hold our uploaded video
let webcamElement = null // This will hold the camera
let videoSize = { width: 640, height: 480 }
let currentMode = 'webcam'
let webcamReady = false
let imageLoaded = false
let videoLoaded = false

// --- UI Elements ---
const modeSelector = document.querySelector('#mode-selector')
const imageControls = document.querySelector('#image-controls')
const videoControls = document.querySelector('#video-controls') // New
const webcamStatus = document.querySelector('#webcam-status')
const fileInput = document.querySelector('#file-input')
const videoInput = document.querySelector('#video-file-input') // New
const videoDropZone = document.querySelector('#video-drop-zone') // New
const loadingEl = document.querySelector('#loading')

function createVideoTexture() {
    if (videoTexture) gl.deleteTexture(videoTexture)
    videoTexture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, videoTexture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    return videoTexture
}

async function initWebcam() {
    webcamStatus.classList.remove('hidden')
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })
        webcamElement = document.createElement('video')
        webcamElement.srcObject = stream
        webcamElement.playsInline = true
        webcamElement.muted = true
        await webcamElement.play()
        videoSize.width = webcamElement.videoWidth
        videoSize.height = webcamElement.videoHeight
        createVideoTexture()
        webcamReady = true
        webcamStatus.classList.add('hidden')
    } catch (err) {
        webcamStatus.innerHTML = '<p>Webcam error.</p>'
    }
}

// New function to handle Video Upload
function loadVideoFromFile(file) {
    loadingEl.classList.remove('hidden')
    const url = URL.createObjectURL(file)
    
    if (!videoElement) {
        videoElement = document.getElementById('stipple-video');
    }
    
    videoElement.src = url;
    videoElement.oncanplay = () => {
        videoElement.play();
        videoSize.width = videoElement.videoWidth;
        videoSize.height = videoElement.videoHeight;
        createVideoTexture();
        videoLoaded = true;
        loadingEl.classList.add('hidden');
    };
}

function switchMode(mode) {
    currentMode = mode;

    // 1. Update button highlights
    modeSelector.querySelectorAll('button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // 2. Hide ALL control panels first
    imageControls.classList.add('hidden');
    videoControls.classList.add('hidden');
    webcamStatus.classList.add('hidden');
    
    // Reset manual display styles
    imageControls.style.display = 'none';
    videoControls.style.display = 'none';

    // 3. Show the specific panel for the selected mode
    if (mode === 'webcam') {
        webcamStatus.classList.remove('hidden');
        if (!webcamReady) initWebcam();
    } 
    else if (mode === 'image') {
        imageControls.style.display = 'flex'; // Force display
        imageControls.classList.remove('hidden');
    } 
    else if (mode === 'video') {
        videoControls.style.display = 'flex'; // Force display
        videoControls.classList.remove('hidden');
        console.log("Video mode activated - Drop zone should be visible now");
    }
}

// Event Listeners
modeSelector.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode))
})

videoInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadVideoFromFile(e.target.files[0])
})
videoDropZone.addEventListener('click', () => videoInput.click())

fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadImageFromFile(e.target.files[0])
})

function render(time) {
    const t = time * 0.001
    let activeSource = null;

    if (currentMode === 'webcam' && webcamReady) activeSource = webcamElement;
    if (currentMode === 'video' && videoLoaded) activeSource = videoElement;
    if (currentMode === 'image' && imageLoaded) activeSource = null; // Images are static textures

    // Update texture if source is a playing video/webcam
    if (activeSource && activeSource.readyState >= 2) {
        gl.bindTexture(gl.TEXTURE_2D, videoTexture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, activeSource)
    }

    if (videoTexture) {
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, videoTexture)
        gl.uniform1i(uniforms.video, 0)
        gl.uniform1f(uniforms.time, t)
        gl.uniform2f(uniforms.videoSize, videoSize.width, videoSize.height)
        sliders.applyUniforms(gl, uniforms)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    requestAnimationFrame(render)
}

function resize() {
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height)
}

window.addEventListener('resize', resize)
resize()
switchMode('webcam')
requestAnimationFrame(render)

// Helper for images (keep your original logic)
function createTextureFromImage(image) {
    createVideoTexture()
    gl.bindTexture(gl.TEXTURE_2D, videoTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    videoSize.width = image.width
    videoSize.height = image.height
    imageLoaded = true
}

function loadImageFromFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => createTextureFromImage(img);
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}