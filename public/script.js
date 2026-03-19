const socket = io();

const callBtn = document.getElementById('callBtn');
const muteBtn = document.getElementById('muteBtn');
const addFriendBtn = document.getElementById('addFriendBtn');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const chatMessages = document.getElementById('chatMessages');
const autoCallCheckbox = document.getElementById('autoCall');
const remoteAudio = document.getElementById('remoteAudio');
const statusMsg = document.querySelector('.status-msg');
const logoCircle = document.getElementById('logoCircle');
const callTimer = document.getElementById('callTimer');
const cameraBtn = document.getElementById('cameraBtn');
const imageInput = document.getElementById('imageInput');

const videoBtn = document.getElementById('videoBtn');
const videoBtnWrapper = document.getElementById('videoBtnWrapper');
const videoBtnText = document.getElementById('videoBtnText');
const videoContainer = document.getElementById('videoContainer');
const callTimerVideo = document.getElementById('callTimerVideo');
const remoteVideo = document.getElementById('remoteVideo');
const localVideo = document.getElementById('localVideo');
const expandVideoBtn = document.getElementById('expandVideoBtn');

// UUID Generator
function getOrCreateUUID() {
    let uuid = localStorage.getItem('airtalk_uuid');
    if (!uuid) {
        uuid = 'xxxx-xxxx-4xxx-yxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
        localStorage.setItem('airtalk_uuid', uuid);
    }
    return uuid;
}
const myUUID = getOrCreateUUID();

let myProfileName = 'Stranger';
let myCurrentGender = localStorage.getItem('airtalk_gender');

const onboardOverlay = document.getElementById('onboardOverlay');
const onboardForm = document.getElementById('onboardForm');

function syncProfile() {
    document.getElementById('myProfileName').textContent = myProfileName || 'Stranger';
    const gSelect = document.getElementById('myGender');
    if (myCurrentGender) {
        gSelect.value = myCurrentGender;
        gSelect.disabled = true; // Lock the gender filter to their actual gender
    }
    socket.emit('update-profile', { name: myProfileName, gender: myCurrentGender, countryName: myCountryName });
}

socket.on('connect', () => {
    socket.emit('register', myUUID);
    if (!myCurrentGender) {
        onboardOverlay.classList.add('show');
    } else {
        syncProfile();
    }
});

onboardForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const genderInput = document.getElementById('onboardGender').value;

    if (genderInput) {
        myProfileName = 'Stranger';
        myCurrentGender = genderInput;
        localStorage.setItem('airtalk_name', 'Stranger');
        localStorage.setItem('airtalk_gender', genderInput);

        onboardOverlay.classList.remove('show');
        syncProfile();
    }
});

socket.on('official-name', (data) => {
    myProfileName = 'Stranger';
    document.getElementById('myProfileName').textContent = 'Stranger';
    if (data.gender && data.gender !== 'any') {
        myCurrentGender = data.gender;
        localStorage.setItem('airtalk_gender', data.gender);
        const gSelect = document.getElementById('myGender');
        gSelect.value = data.gender;
        gSelect.disabled = true;
    }
});

socket.on('db-data', (data) => {
    if (data.history) callHistory = data.history.map(item => ({ id: item.id, name: item.name, timestamp: item.timestamp }));
    if (data.friends) friendsList = data.friends.map(item => ({ id: item.id, name: item.name }));
});

let myCountryCode = 'un';
let myCountryName = 'Unknown';

async function fetchLocation() {
    try {
        const res = await fetch('https://get.geojs.io/v1/ip/geo.json');
        const data = await res.json();
        myCountryCode = data.country_code ? data.country_code.toLowerCase() : 'un';
        myCountryName = data.country || 'Unknown';
    } catch (e) {
        console.error('Location fetch failed', e);
    }
}
fetchLocation();

let localStream;
let peerConnection;
let isCalling = false;
let isMuted = false;
let callInterval = null;
let callStartTime = null;

let callHistory = [];
let friendsList = [];
let currentPartner = null;

let videoTrack = null;
let isVideoOn = false;

const servers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

// 1. Get access to microphone
async function getMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000
            },
            video: false
        });
    } catch (err) {
        console.error('Error accessing media devices.', err);
        statusMsg.innerHTML = '<span style="color:#e74c3c">Microphone access required for audio calls!</span>';
    }
}
getMedia();

// 2. Call button logic
callBtn.addEventListener('click', () => {
    if (!isCalling) {
        startCall();
    } else {
        endCall();
    }
});

function startCall() {
    const myGender = document.getElementById('myGender').value;
    const targetGender = document.getElementById('targetGender').value;
    const targetCountry = document.getElementById('targetCountry').value;

    socket.emit('join-wait', {
        countryCode: myCountryCode,
        countryName: myCountryName,
        randomName: myProfileName,
        myGender: myCurrentGender,
        targetGender: targetGender,
        targetCountry: targetCountry
    });
    callBtn.style.background = 'linear-gradient(135deg, #f39c12, #f1c40f)'; // Yellow processing color
    callBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    callBtn.nextElementSibling.textContent = 'Searching...';
    statusMsg.innerHTML = 'Searching for a stranger...';
}

function endCall() {
    socket.emit('end-call');
    cleanupCall();
    if (autoCallCheckbox.checked) {
        startCall();
    }
}

function cleanupCall() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    isCalling = false;

    if (currentPartner) {
        let ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        // Don't add duplicate immediate rows to history array if exists, keep top 10
        if (!callHistory.find(h => h.id === currentPartner.id)) {
            callHistory.unshift({
                id: currentPartner.id,
                name: currentPartner.name,
                timestamp: ts
            });
        }
        if (callHistory.length > 10) callHistory.pop();
        currentPartner = null;
    }

    // UI Reset
    logoCircle.classList.remove('active-call');
    callTimer.style.display = 'none';
    clearInterval(callInterval);

    logoCircle.style.display = 'flex';
    videoContainer.style.display = 'none';
    videoContainer.classList.remove('fullscreen');
    document.body.classList.remove('video-fullscreen');
    if (expandVideoBtn) {
        expandVideoBtn.querySelector('i').className = 'fas fa-expand';
    }

    if (videoTrack) {
        videoTrack.stop();
        videoTrack = null;
    }
    isVideoOn = false;
    videoBtn.style.background = '';
    videoBtn.innerHTML = '<i class="fas fa-video-slash"></i>';
    videoBtnText.style.color = '#50606e';
    videoBtnText.textContent = 'Video';
    remoteVideo.srcObject = null;
    localVideo.srcObject = null;

    callBtn.style.backgroundColor = '';
    callBtn.style.background = 'linear-gradient(135deg, #2eac5f, #3bcf76)';
    callBtn.innerHTML = '<i class="fas fa-phone-alt"></i>';
    callBtn.nextElementSibling.textContent = 'Call';
    videoBtnWrapper.style.display = 'none';
    addFriendBtn.disabled = false;
    addFriendBtn.style.color = ''; // Reset friend button color
    statusMsg.innerHTML = 'Tap the <span class="highlight-green">Call</span> button to call a new stranger';
    chatInput.disabled = true;
    sendBtn.disabled = true;
    cameraBtn.disabled = true;
    chatMessages.innerHTML = ''; // clear chat
    addSystemMessage('Call ended.');
}

// 3. Socket events for signaling
socket.on('waiting', () => {
    statusMsg.innerHTML = 'Waiting for someone to connect...';
});

socket.on('matched', async (data) => {
    isCalling = true;

    // Reveal Video Button
    videoBtnWrapper.style.display = 'flex';

    callBtn.style.background = 'linear-gradient(135deg, #e74c3c, #c0392b)'; // Red for end call
    callBtn.innerHTML = '<i class="fas fa-phone-slash"></i>';
    callBtn.nextElementSibling.textContent = 'Hang up';

    // Country Logic
    const partnerData = data.partnerData || { countryCode: 'un', countryName: 'Unknown Location', randomName: 'Stranger' };
    const flagHTML = partnerData.countryCode !== 'un'
        ? `<img src="https://flagcdn.com/24x18/${partnerData.countryCode}.png" alt="${partnerData.countryName}" style="vertical-align: middle; margin: 0 4px; border-radius: 2px;">`
        : `🌍`;

    const displayName = partnerData.randomName || partnerData.countryName;

    statusMsg.innerHTML = `Connected to ${flagHTML} <b>${displayName}</b> (${partnerData.countryName})!`;

    currentPartner = { id: data.partnerUUID || data.partnerId, name: displayName };

    // Turn on Timer
    logoCircle.classList.add('active-call');
    callTimer.style.display = 'block';
    callStartTime = Date.now();
    callTimer.textContent = '00:00:00';

    clearInterval(callInterval);
    callInterval = setInterval(() => {
        const diff = Math.floor((Date.now() - callStartTime) / 1000);
        const h = String(Math.floor(diff / 3600)).padStart(2, '0');
        const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
        const s = String(diff % 60).padStart(2, '0');
        const timeStr = h === '00' ? `${m}:${s}` : `${h}:${m}:${s}`;
        callTimer.textContent = timeStr;
        callTimerVideo.textContent = timeStr;
    }, 1000);

    // Enable chat
    chatInput.disabled = false;
    sendBtn.disabled = false;
    cameraBtn.disabled = false;
    chatMessages.innerHTML = '';

    const sysMsgDiv = document.createElement('div');
    sysMsgDiv.classList.add('system-msg');
    sysMsgDiv.innerHTML = `You are now talking to ${flagHTML} <b>${currentPartner.name}</b> from ${partnerData.countryName}. Say hi!`;
    chatMessages.appendChild(sysMsgDiv);

    peerConnection = new RTCPeerConnection(servers);

    // Add local tracks to peer connection
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }

    // Listen for remote tracks (both audio and video mid-flight)
    peerConnection.ontrack = (event) => {
        if (event.track.kind === 'audio') {
            remoteAudio.srcObject = event.streams[0];
        } else if (event.track.kind === 'video') {
            remoteVideo.srcObject = event.streams[0];
            logoCircle.style.display = 'none';
            videoContainer.style.display = 'block';

            event.track.onended = () => {
                remoteVideo.srcObject = null;
                if (!isVideoOn) {
                    logoCircle.style.display = 'flex';
                    videoContainer.style.display = 'none';
                }
            };
        }
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', event.candidate);
        }
    };

    if (data.role === 'caller') {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('offer', offer);
    }
});

socket.on('offer', async (data) => {
    if (!peerConnection) return;
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', answer);
    } catch (e) { }
});

socket.on('answer', async (data) => {
    if (!peerConnection) return;
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
    } catch (e) { }
});

socket.on('ice-candidate', async (candidate) => {
    if (!peerConnection) return;
    try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
        console.error('Error adding received ice candidate', e);
    }
});

socket.on('partner-disconnected', () => {
    addSystemMessage('Stranger disconnected.');
    pendingFriendRequestFrom = null;
    const badge = document.getElementById('friendRequestBadge');
    if (badge) badge.style.display = 'none';
    
    if (sidePanel.classList.contains('open') && document.getElementById('panelTitle').textContent === 'Friend List') {
        document.getElementById('openFriendsBtn').click(); // repaint panel if open
    }
    
    cleanupCall();
    if (autoCallCheckbox.checked) {
        setTimeout(startCall, 1000); // slight delay before calling again
    }
});

// 4. Mute toggle
muteBtn.addEventListener('click', () => {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks()[0].enabled = !isMuted;

    if (isMuted) {
        muteBtn.style.backgroundColor = '#e74c3c'; // Warning red or similar
        muteBtn.style.borderColor = '#e74c3c';
        muteBtn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
    } else {
        muteBtn.style.backgroundColor = 'transparent';
        muteBtn.style.borderColor = 'white';
        muteBtn.innerHTML = '<i class="fas fa-microphone"></i>';
    }
});

// 5. Video toggle logic
videoBtn.addEventListener('click', async () => {
    if (!isCalling || !peerConnection) return;

    if (!isVideoOn) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true });
            videoTrack = stream.getVideoTracks()[0];
            localVideo.srcObject = stream;

            peerConnection.addTrack(videoTrack, stream);

            isVideoOn = true;
            videoBtn.style.background = 'linear-gradient(135deg, #e74c3c, #c0392b)';
            videoBtn.innerHTML = '<i class="fas fa-video"></i>';
            videoBtnText.style.color = '#e74c3c';
            videoBtnText.textContent = 'Stop Video';

            logoCircle.style.display = 'none';
            videoContainer.style.display = 'block';

            // Renegotiate mid-call
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('offer', offer);

            videoTrack.onended = stopCamera;
        } catch (e) {
            addSystemMessage('Camera access denied!');
        }
    } else {
        stopCamera();
    }
});

async function stopCamera() {
    if (!videoTrack) return;
    videoTrack.stop();
    const senders = peerConnection.getSenders();
    const sender = senders.find(s => s.track === videoTrack);
    if (sender) peerConnection.removeTrack(sender);
    videoTrack = null;
    isVideoOn = false;

    videoBtn.style.background = '';
    videoBtn.innerHTML = '<i class="fas fa-video-slash"></i>';
    videoBtnText.style.color = '#50606e';
    videoBtnText.textContent = 'Video';
    localVideo.srcObject = null;

    // Renegotiate removal
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('offer', offer);

    // Reverse UI if stranger has no video on
    if (!remoteVideo.srcObject) {
        logoCircle.style.display = 'flex';
        videoContainer.style.display = 'none';
    }
}

// 6. Friend buttons
addFriendBtn.addEventListener('click', () => {
    if (!isCalling) return;
    socket.emit('friend-request');
    addFriendBtn.disabled = true;
    addSystemMessage('Friend request sent.');
});

let pendingFriendRequestFrom = null;

socket.on('friend-request', () => {
    if (!currentPartner) return;
    pendingFriendRequestFrom = { ...currentPartner };

    // Update top friend icon badge
    const badge = document.getElementById('friendRequestBadge');
    if (badge) {
        badge.textContent = '1';
        badge.style.display = 'flex';
    }
});

socket.on('friend-accepted', () => {
    addSystemMessage('Stranger accepted your friend request!');
    if (currentPartner && !friendsList.find(f => f.id === currentPartner.id)) {
        friendsList.push({ ...currentPartner });
    }
    addFriendBtn.style.color = '#2eac5f';
});

// 6. Chat functions
function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || !isCalling) return;

    socket.emit('chat-message', text);

    socket.emit('stop-typing');
    clearTimeout(typingTimeout);

    // add to ui
    const msgEl = document.createElement('div');
    msgEl.classList.add('message', 'local');
    msgEl.textContent = text;
    chatMessages.appendChild(msgEl);
    chatMessages.parentElement.scrollTop = chatMessages.parentElement.scrollHeight;

    chatInput.value = '';
}

// 6B. Image Sending Logic
cameraBtn.addEventListener('click', () => {
    if (isCalling) imageInput.click();
});

imageInput.addEventListener('change', function () {
    const file = this.files[0];
    if (!file || !isCalling) return;

    // Prevent massive images from crashing the socket loop (3MB max)
    if (file.size > 3 * 1024 * 1024) {
        addSystemMessage("Image is too large. Max size is 3MB.");
        this.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
        const imgDataUrl = e.target.result;
        socket.emit('chat-image', imgDataUrl);

        // Add to local UI immediately
        const msgEl = document.createElement('div');
        msgEl.classList.add('message', 'local');
        const imgEl = document.createElement('img');
        imgEl.src = imgDataUrl;
        msgEl.appendChild(imgEl);

        chatMessages.appendChild(msgEl);
        chatMessages.parentElement.scrollTop = chatMessages.parentElement.scrollHeight;
    };
    reader.readAsDataURL(file);

    // clear input for identical subsequent uploads
    this.value = '';
});

let typingTimeout = null;

chatInput.addEventListener('input', () => {
    if (!isCalling) return;

    socket.emit('typing');

    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('stop-typing');
    }, 1500);
});

sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

function handleIncomingMessageUI() {
    if (window.innerWidth <= 850) {
        if (!mainChatContent.classList.contains('open')) {
            unreadMessagesCount++;
            chatUnreadBadge.textContent = unreadMessagesCount;
            chatUnreadBadge.style.display = 'flex';
        } else {
            chatMessages.parentElement.scrollTop = chatMessages.parentElement.scrollHeight;
        }
    } else {
        chatMessages.parentElement.scrollTop = chatMessages.parentElement.scrollHeight;
    }
}

socket.on('chat-message', (msg) => {
    const msgEl = document.createElement('div');
    msgEl.classList.add('message', 'remote');
    msgEl.textContent = msg;
    chatMessages.appendChild(msgEl);
    handleIncomingMessageUI();
});

socket.on('chat-image', (imgData) => {
    const msgEl = document.createElement('div');
    msgEl.classList.add('message', 'remote');
    const imgEl = document.createElement('img');
    imgEl.src = imgData;
    msgEl.appendChild(imgEl);

    chatMessages.appendChild(msgEl);

    // Must wait for image paint to calculate correct scrollHeight
    imgEl.onload = () => {
        handleIncomingMessageUI();
    };
});

function addSystemMessage(text) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    
    const msgEl = document.createElement('div');
    msgEl.classList.add('system-toast');
    msgEl.textContent = text;
    container.appendChild(msgEl);
    
    // Force reflow for animation
    void msgEl.offsetWidth;
    
    msgEl.classList.add('show');
    
    setTimeout(() => {
        msgEl.classList.remove('show');
        setTimeout(() => {
            if (msgEl.parentNode) msgEl.remove();
        }, 400); // wait for fade out
    }, 3500); // show for 3.5s
}

// 7. Online users count
socket.on('online-count', (count) => {
    const onlineCounter = document.getElementById('onlineCount');
    if (onlineCounter) {
        onlineCounter.textContent = count;
    }
});

// 8. Typing Indicator
const typingIndicator = document.getElementById('typingIndicator');

socket.on('typing', () => {
    if (typingIndicator) typingIndicator.style.display = 'block';
});

socket.on('stop-typing', () => {
    if (typingIndicator) typingIndicator.style.display = 'none';
});

// 9. Side Panel (Friends & History)
const sidePanel = document.getElementById('sidePanel');
const panelTitle = document.getElementById('panelTitle');
const panelContent = document.getElementById('panelContent');

document.getElementById('openFriendsBtn').addEventListener('click', () => {
    panelTitle.textContent = 'Friend List';
    sidePanel.classList.add('open');
    panelContent.innerHTML = '<div style="text-align:center; color:#7b84aa; margin-top:20px;"><i class="fas fa-spinner fa-spin"></i> Loading context...</div>';

    // Clear badge count instantly when opened
    const badge = document.getElementById('friendRequestBadge');
    if (badge) badge.style.display = 'none';

    const ids = friendsList.map(item => item.id);

    socket.emit('check-status', ids, (statuses) => {
        panelContent.innerHTML = '';
        let hasContent = false;

        // Render Pending Request
        if (pendingFriendRequestFrom) {
            panelContent.innerHTML += `
                <div style="font-size:12px; font-weight:700; color:#f1c40f; text-transform:uppercase; margin-bottom:5px;">Pending Request</div>
                <div class="list-item" style="border: 1px dashed rgba(241,196,15,0.4); background: rgba(241,196,15,0.05); flex-direction:column; align-items:flex-start;">
                    <div style="display:flex; align-items:center; width: 100%; margin-bottom: 10px;">
                        <div class="avatar" style="background: rgba(241,196,15,0.2); color: #f1c40f;">
                            <i class="fas fa-user-clock"></i>
                        </div>
                        <div class="list-item-info" style="margin-left: 10px;">
                            <div class="list-item-title">${pendingFriendRequestFrom.name || 'Stranger'}</div>
                            <div class="list-item-sub">Wants to be friends</div>
                        </div>
                    </div>
                    <div style="display:flex; gap:10px; width: 100%;">
                        <button id="panelAcceptFriendBtn" style="flex:1; background:linear-gradient(135deg, #2eac5f, #3bcf76); color:white; border:none; border-radius:15px; padding:8px 0; cursor:pointer; font-weight:700; font-size:12px;">Accept</button>
                        <button id="panelCancelFriendBtn" style="flex:1; background:transparent; color:#e74c3c; border:1px solid #e74c3c; border-radius:15px; padding:8px 0; cursor:pointer; font-weight:700; font-size:12px;">Cancel</button>
                    </div>
                </div>
                <div style="height: 15px;"></div>
            `;
            hasContent = true;
        }

        // Render Friends List
        if (friendsList.length > 0) {
            panelContent.innerHTML += `<div style="font-size:12px; font-weight:700; color:#b8c1ec; text-transform:uppercase; margin-bottom:5px;">My Friends (${friendsList.length})</div>`;
            friendsList.forEach(item => {
                const isOnline = statuses[item.id] || false;
                panelContent.innerHTML += `
                    <div class="list-item">
                        <div class="avatar">
                            <i class="fas fa-user"></i>
                            <div class="status-dot ${isOnline ? 'online' : 'offline'}"></div>
                        </div>
                        <div class="list-item-info">
                            <div class="list-item-title">${item.name}</div>
                            <div class="list-item-sub">${isOnline ? 'Online Now' : 'Offline'}</div>
                        </div>
                        ${isOnline ? `<button class="direct-call-btn" data-uuid="${item.id}" data-name="${item.name}"><i class="fas fa-phone-volume"></i></button>` : ''}
                    </div>
                `;
            });
            hasContent = true;
        }

        if (!hasContent) {
            panelContent.innerHTML = '<div style="text-align:center; color:#7b84aa; margin-top:20px; font-weight: 500;">Nothing to show yet.<br>Call someone first! 🌏</div>';
        }

        // Connect panel buttons
        const pAccept = document.getElementById('panelAcceptFriendBtn');
        const pCancel = document.getElementById('panelCancelFriendBtn');

        if (pAccept) {
            pAccept.onclick = () => {
                socket.emit('accept-friend');
                if (pendingFriendRequestFrom && !friendsList.find(f => f.id === pendingFriendRequestFrom.id)) {
                    friendsList.push({ ...pendingFriendRequestFrom });
                }
                pendingFriendRequestFrom = null;
                const badge = document.getElementById('friendRequestBadge');
                if (badge) badge.style.display = 'none';
                
                addFriendBtn.style.color = '#2eac5f';
                addSystemMessage('You are now friends!');
                
                document.getElementById('openFriendsBtn').click(); // refresh list
            };
        }

        if (pCancel) {
            pCancel.onclick = () => {
                pendingFriendRequestFrom = null;
                const badge = document.getElementById('friendRequestBadge');
                if (badge) badge.style.display = 'none';
                
                document.getElementById('openFriendsBtn').click(); // refresh list
            };
        }
    });
});

document.querySelector('.history-link').addEventListener('click', (e) => {
    e.preventDefault();
    panelTitle.textContent = 'Call History';
    openPanel(callHistory);
});

document.getElementById('closePanelBtn').addEventListener('click', () => {
    sidePanel.classList.remove('open');
});

function openPanel(dataList) {
    sidePanel.classList.add('open');
    panelContent.innerHTML = '<div style="text-align:center; color:#7b84aa; margin-top:20px;"><i class="fas fa-spinner fa-spin"></i> Loading metadata...</div>';

    if (dataList.length === 0) {
        panelContent.innerHTML = '<div style="text-align:center; color:#7b84aa; margin-top:20px; font-weight: 500;">Nothing to show yet.<br>Call someone first! 🌏</div>';
        return;
    }

    const ids = dataList.map(item => item.id);

    socket.emit('check-status', ids, (statuses) => {
        panelContent.innerHTML = '';
        dataList.forEach(item => {
            const isOnline = statuses[item.id];
            panelContent.innerHTML += `
                <div class="list-item">
                    <div class="avatar">
                        <i class="fas fa-user"></i>
                        <div class="status-dot ${isOnline ? 'online' : 'offline'}"></div>
                    </div>
                    <div class="list-item-info">
                        <div class="list-item-title">${item.name}</div>
                        <div class="list-item-sub">${item.timestamp ? 'Called at ' + item.timestamp : (isOnline ? 'Online Now' : 'Offline')}</div>
                    </div>
                    ${isOnline ? `<button class="direct-call-btn" data-uuid="${item.id}" data-name="${item.name}"><i class="fas fa-phone-volume"></i></button>` : ''}
                </div>
            `;
        });
    });
}

// 10. Direct Calling Logic
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.direct-call-btn');
    if (btn) {
        if (isCalling) {
            alert("You are already in a call! Hang up first.");
            return;
        }
        const uuid = btn.getAttribute('data-uuid');
        const name = btn.getAttribute('data-name');

        socket.emit('request-direct-call', { targetUUID: uuid });

        statusMsg.innerHTML = `Calling <b>${name}</b>...`;
        callBtn.style.background = 'linear-gradient(135deg, #f39c12, #f1c40f)';
        callBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        callBtn.nextElementSibling.textContent = 'Ringing...';
        sidePanel.classList.remove('open');
    }
});

let pendingDirectCallId = null;

socket.on('incoming-direct-call', (data) => {
    if (isCalling) {
        socket.emit('decline-direct-call', { callerUUID: data.callerUUID });
        return;
    }
    pendingDirectCallId = data.callerUUID;
    document.getElementById('incomingCallerName').textContent = data.callerName;
    document.getElementById('incomingCallNotification').classList.add('show');

    // Auto timeout after 60s
    setTimeout(() => {
        if (pendingDirectCallId === data.callerUUID) {
            document.getElementById('incomingCallNotification').classList.remove('show');
            socket.emit('decline-direct-call', { callerUUID: data.callerUUID, reason: 'timeout' });
            pendingDirectCallId = null;
        }
    }, 60000);
});

document.getElementById('acceptDirectCallBtn').addEventListener('click', () => {
    document.getElementById('incomingCallNotification').classList.remove('show');
    if (pendingDirectCallId) {
        socket.emit('accept-direct-call', { callerUUID: pendingDirectCallId });
        pendingDirectCallId = null;
    }
});

document.getElementById('declineDirectCallBtn').addEventListener('click', () => {
    document.getElementById('incomingCallNotification').classList.remove('show');
    if (pendingDirectCallId) {
        socket.emit('decline-direct-call', { callerUUID: pendingDirectCallId });
        pendingDirectCallId = null;
    }
});

socket.on('direct-call-declined', (data) => {
    if (data && data.reason === 'timeout') {
        statusMsg.innerHTML = 'Stranger is not answering your call.';
    } else {
        statusMsg.innerHTML = 'User declined the call or is busy.';
    }
    setTimeout(() => {
        cleanupCall();
    }, 3000);
});

// 11. Fullscreen / Expand Video Logic
if (expandVideoBtn) {
    expandVideoBtn.addEventListener('click', () => {
        document.body.classList.toggle('video-fullscreen');
        videoContainer.classList.toggle('fullscreen');
        const icon = expandVideoBtn.querySelector('i');
        if (videoContainer.classList.contains('fullscreen')) {
            icon.classList.remove('fa-expand');
            icon.classList.add('fa-compress');
        } else {
            icon.classList.remove('fa-compress');
            icon.classList.add('fa-expand');
        }
    });
}

// 12. Top Bar Navigation Hooks
const toggleFiltersBtn = document.getElementById('toggleFiltersBtn');
const filterContainer = document.getElementById('filterDropdown');

// Initially hide filter container if not already handled by CSS
if (filterContainer) filterContainer.style.display = 'none';

if (toggleFiltersBtn) {
    toggleFiltersBtn.addEventListener('click', (e) => {
        // Prevent body click from hiding it immediately
        e.stopPropagation();
        if (filterContainer.style.display === 'none') {
            filterContainer.style.display = 'flex';
        } else {
            filterContainer.style.display = 'none';
        }
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
        if (filterContainer && !filterContainer.contains(e.target) && !toggleFiltersBtn.contains(e.target)) {
            filterContainer.style.display = 'none';
        }
    });
}

const myProfileBadge = document.getElementById('myProfileBadge');
if (myProfileBadge) {
    myProfileBadge.addEventListener('click', () => {
        const onboardGender = document.getElementById('onboardGender');

        if (myCurrentGender && myCurrentGender !== 'any') {
            onboardGender.value = myCurrentGender;
            onboardGender.disabled = false; // Allow them to change it if they want
        }

        // Show a temporary close button since they are just editing
        let closeBtn = document.getElementById('onboardCloseBtn');
        if (!closeBtn) {
            closeBtn = document.createElement('button');
            closeBtn.id = 'onboardCloseBtn';
            closeBtn.textContent = 'Cancel';
            closeBtn.className = 'incoming-btn-large decline';
            closeBtn.style.marginTop = '10px';
            closeBtn.type = 'button';
            closeBtn.onclick = () => {
                onboardOverlay.classList.remove('show');
            };
            onboardForm.appendChild(closeBtn);
        }
        closeBtn.style.display = 'block';

        onboardOverlay.classList.add('show');
    });
}

// 13. Mobile Chat Toggle Hooks
const mobileChatToggleBtn = document.getElementById('mobileChatToggleBtn');
const mainChatContent = document.getElementById('mainChatContent');
const closeChatMobileBtn = document.getElementById('closeChatMobileBtn');
const chatUnreadBadge = document.getElementById('chatUnreadBadge');

let unreadMessagesCount = 0;

if (mobileChatToggleBtn && closeChatMobileBtn && mainChatContent) {
    mobileChatToggleBtn.addEventListener('click', () => {
        mainChatContent.classList.add('open');
        unreadMessagesCount = 0;
        if (chatUnreadBadge) {
            chatUnreadBadge.textContent = '0';
            chatUnreadBadge.style.display = 'none';
        }
        // Auto scroll to latest messages on mobile open
        if (chatMessages) {
            chatMessages.parentElement.scrollTop = chatMessages.parentElement.scrollHeight;
        }
    });

    closeChatMobileBtn.addEventListener('click', () => {
        mainChatContent.classList.remove('open');
    });
}

// 14. Report and Block Logic
const reportBtn = document.getElementById('reportBtn');
const reportOverlay = document.getElementById('reportOverlay');
const reportForm = document.getElementById('reportForm');
const cancelReportBtn = document.getElementById('cancelReportBtn');

if (reportBtn && reportOverlay) {
    reportBtn.addEventListener('click', () => {
        if (!isCalling) return;
        reportOverlay.classList.add('show');
    });
}

if (cancelReportBtn && reportOverlay) {
    cancelReportBtn.addEventListener('click', () => {
        reportOverlay.classList.remove('show');
    });
}

if (reportForm && reportOverlay) {
    reportForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const reason = document.getElementById('reportReason').value;
        if (!reason || !isCalling) return;

        socket.emit('report-block', { reason });
        reportOverlay.classList.remove('show');
        addSystemMessage('You have reported and blocked this stranger.');

        // Immediately disconnect local UI and jump to next if auto-call enabled
        cleanupCall();
        if (autoCallCheckbox && autoCallCheckbox.checked) {
            startCall();
        }
    });
}
