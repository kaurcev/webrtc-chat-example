const statusDiv = document.getElementById('status');
const messagesDiv = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const fileInput = document.getElementById('fileInput');
const fileInputAll = document.getElementById('fileInputAll');
const fileInputImage = document.getElementById('fileInputImage');
const chatInputContainer = document.getElementById('chatInputContainer');
const connectionPanel = document.getElementById('connectionPanel');
const photoCanvas = document.getElementById('photoCanvas');
const timeEstimate = document.getElementById('timeEstimate');
const loadMoreButton = document.getElementById('loadMore');

let peerConnection = null;
let dataChannel = null;
let isOfferer = false;
let localIceCandidates = [];
let imageChunks = {};
let fileChunks = {};
let photoContext;
let isSendingFile = false;
let db = null;
let currentMessageOffset = 0;
const MESSAGES_PER_PAGE = 20;
let allMessages = [];
let renderedMessages = new Set();

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' },
        { urls: 'stun:stun.stunprotocol.org:3478' }
    ]
};

photoCanvas.width = 1024;
photoCanvas.height = 768;
photoContext = photoCanvas.getContext('2d');

const DB_NAME = 'ChatDB';
const DB_VERSION = 1;
const STORE_NAME = 'messages';

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
    });
}

async function saveMessageToDB(message) {
    if (!db) db = await openDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.add({
            ...message,
            timestamp: new Date().toISOString()
        });

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
}

async function loadMessagesFromDB(offset = 0, limit = MESSAGES_PER_PAGE) {
    if (!db) db = await openDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('timestamp');
        const request = index.getAll();

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const allMessages = request.result;
            const start = Math.max(0, allMessages.length - offset - limit);
            const end = allMessages.length - offset;
            const messages = allMessages.slice(start, end);
            resolve({
                messages: messages.reverse(),
                hasMore: start > 0
            });
        };
    });
}

async function displayMessages(offset = 0) {
    try {
        const { messages, hasMore } = await loadMessagesFromDB(offset, MESSAGES_PER_PAGE);

        if (offset === 0) {
            messagesDiv.innerHTML = '';
            if (hasMore) {
                messagesDiv.appendChild(loadMoreButton);
            }
            renderedMessages.clear();
        }

        const fragment = document.createDocumentFragment();

        messages.forEach(message => {
            if (renderedMessages.has(message.id)) return;

            renderedMessages.add(message.id);

            if (message.type === 'text') {
                const element = createTextMessage(message.sender, message.content, message.sender === 'me', message.timestamp);
                if (offset > 0) {
                    fragment.insertBefore(element, fragment.firstChild);
                } else {
                    fragment.appendChild(element);
                }
            } else if (message.type === 'image') {
                const element = createImageMessage(message.sender, message.data, message.sender === 'me', message.timestamp);
                if (offset > 0) {
                    fragment.insertBefore(element, fragment.firstChild);
                } else {
                    fragment.appendChild(element);
                }
            }
        });

        if (offset > 0) {
            messagesDiv.insertBefore(fragment, loadMoreButton);
        } else {
            messagesDiv.appendChild(fragment);
        }

        loadMoreButton.style.display = hasMore ? 'block' : 'none';

        if (offset === 0) {
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }

    } catch (error) {
        console.error('Ошибка загрузки сообщений:', error);
    }
}

async function loadMoreMessages() {
    currentMessageOffset += MESSAGES_PER_PAGE;
    await displayMessages(currentMessageOffset);
}

function clearChat() {
    if (!confirm('Очистить всю историю чата?')) return;

    renderedMessages.clear();
    messagesDiv.innerHTML = '';
    currentMessageOffset = 0;

    if (db) {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        store.clear();
    }

    const systemMessage = document.createElement('div');
    systemMessage.className = 'message-system';
    systemMessage.textContent = 'История чата очищена';
    messagesDiv.appendChild(systemMessage);
}

function updateTimeEstimate() {
    const text = messageInput.value;
    if (!text.trim()) {
        timeEstimate.textContent = '';
        return;
    }

    const words = text.trim().split(/\s+/).length;
    const timeSeconds = Math.max(1, Math.ceil(words / 5));
    timeEstimate.textContent = `~${timeSeconds} сек`;
}

messageInput.addEventListener('input', updateTimeEstimate);

fileInput.onchange = async (event) => {
    const file = event.target.files[0];
    if (!file || !file.name.endsWith('.kae')) {
        alert('Пожалуйста, выберите файл с расширением .kae');
        return;
    }

    try {
        const fileContent = await file.text();
        const signalData = JSON.parse(fileContent);
        await handleImportedSignal(signalData);
    } catch (err) {
        console.error('Ошибка при чтении файла:', err);
        updateStatus('Ошибка при чтении файла: ' + err.message, 'error');
    }
};

fileInputAll.onchange = async (event) => {
    if (isSendingFile) {
        alert('Дождитесь окончания отправки текущего файла');
        return;
    }

    const file = event.target.files[0];
    if (!file) return;

    await sendFile(file);
};

fileInputImage.onchange = async (event) => {
    if (isSendingFile) {
        alert('Дождитесь окончания отправки текущего файла');
        return;
    }

    const file = event.target.files[0];
    if (!file || !file.type.startsWith('image/')) {
        alert('Пожалуйста, выберите изображение');
        return;
    }

    previewImage(file);
};

function previewImage(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
        const img = new Image();
        img.onload = () => {
            photoContext.clearRect(0, 0, photoCanvas.width, photoCanvas.height);
            const ratio = Math.min(photoCanvas.width / img.width, photoCanvas.height / img.height);
            const width = img.width * ratio;
            const height = img.height * ratio;
            const x = (photoCanvas.width - width) / 2;
            const y = (photoCanvas.height - height) / 2;

            photoContext.drawImage(img, x, y, width, height);
            sendPhoto();
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

async function createOfferAndDownload() {
    try {
        isOfferer = true;
        localIceCandidates = [];
        await createPeerConnection();

        dataChannel = peerConnection.createDataChannel('chatChannel', {
            ordered: true,
        });
        setupDataChannel(dataChannel);

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        updateStatus('Оффер создан, собираем ICE кандидаты...');

        await waitForIceGathering();

        const offerData = {
            type: 'offer',
            sdp: peerConnection.localDescription.sdp,
            candidates: localIceCandidates,
            timestamp: new Date().toISOString()
        };

        downloadKaeFile(offerData, 'webrtc_offer.kae');
        updateStatus('Оффер создан и сохранен в файл. Передайте файл партнеру.');

    } catch (error) {
        console.error('Ошибка создания оффера:', error);
        updateStatus('Ошибка создания оффера: ' + error.message, 'error');
    }
}

function importKaeFile() {
    fileInput.click();
}

async function handleImportedSignal(signalData) {
    try {
        if (signalData.type === 'offer') {
            if (!peerConnection) {
                await createPeerConnection();
            }

            await peerConnection.setRemoteDescription(
                new RTCSessionDescription({ type: 'offer', sdp: signalData.sdp })
            );

            if (signalData.candidates && signalData.candidates.length > 0) {
                for (const candidate of signalData.candidates) {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                }
            }

            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);

            updateStatus('Ответ создан, собираем ICE кандидаты...');

            await waitForIceGathering();

            const answerData = {
                type: 'answer',
                sdp: peerConnection.localDescription.sdp,
                candidates: localIceCandidates,
                timestamp: new Date().toISOString()
            };

            downloadKaeFile(answerData, 'webrtc_answer.kae');
            updateStatus('Ответ создан и сохранен в файл. Верните файл инициатору.');

        } else if (signalData.type === 'answer') {
            if (peerConnection && peerConnection.signalingState === 'have-local-offer') {
                await peerConnection.setRemoteDescription(
                    new RTCSessionDescription({ type: 'answer', sdp: signalData.sdp })
                );

                if (signalData.candidates && signalData.candidates.length > 0) {
                    for (const candidate of signalData.candidates) {
                        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                    }
                }

                updateStatus('Ответ установлен, подключение устанавливается...');
            }
        }
    } catch (error) {
        console.error('Ошибка обработки сигнала:', error);
        updateStatus('Ошибка обработки сигнала: ' + error.message, 'error');
    }
}

async function createPeerConnection() {
    if (peerConnection) {
        peerConnection.close();
    }

    peerConnection = new RTCPeerConnection(configuration);
    localIceCandidates = [];

    peerConnection.ondatachannel = (event) => {
        dataChannel = event.channel;
        setupDataChannel(dataChannel);
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            localIceCandidates.push(event.candidate.toJSON());
        }
    };

    peerConnection.oniceconnectionstatechange = () => {
        const state = peerConnection.iceConnectionState;
        updateStatus(`ICE состояние: ${state}`);

        if (state === 'connected' || state === 'completed') {
            updateStatus('DataChannel подключен!', 'connected');
            showChatInterface();
        } else if (state === 'failed') {
            updateStatus('Ошибка подключения ICE', 'error');
        }
    };

    peerConnection.onconnectionstatechange = () => {
        updateStatus(`Состояние подключения: ${peerConnection.connectionState}`);
    };
}

function showChatInterface() {
    connectionPanel.classList.add('hidden');
    chatInputContainer.classList.remove('hidden');
    displayMessages(0);
}

function waitForIceGathering() {
    return new Promise((resolve) => {
        if (peerConnection.iceGatheringState === 'complete') {
            resolve();
            return;
        }

        const checkState = () => {
            if (peerConnection.iceGatheringState === 'complete') {
                resolve();
            }
        };

        peerConnection.addEventListener('icegatheringstatechange', checkState);

        setTimeout(() => {
            peerConnection.removeEventListener('icegatheringstatechange', checkState);
            resolve();
        }, 5000);
    });
}

function setupDataChannel(channel) {
    channel.onopen = () => {
        updateStatus('DataChannel открыт', 'connected');
        showChatInterface();
        addSystemMessage('DataChannel подключен!');
    };

    channel.onclose = () => {
        updateStatus('DataChannel закрыт');
        addSystemMessage('DataChannel отключен');
    };

    channel.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            if (data.type === 'image_start') {
                imageChunks[data.id] = {
                    received: 0,
                    total: data.chunkCount,
                    width: data.width,
                    height: data.height,
                    data: new Uint8ClampedArray(data.totalBytes)
                };
            } else if (data.type === 'image_chunk') {
                handleImageChunk(data);
            } else if (data.type === 'file_start') {
                fileChunks[data.id] = {
                    received: 0,
                    total: data.chunkCount,
                    fileName: data.fileName,
                    fileSize: data.fileSize,
                    fileType: data.fileType,
                    data: []
                };
            } else if (data.type === 'file_chunk') {
                handleFileChunk(data);
            } else if (data.type === 'text') {
                addMessage('Партнер', data.message, false);
                saveMessageToDB({
                    type: 'text',
                    sender: 'partner',
                    content: data.message
                });
            }
        } catch (error) {
            addMessage('Партнер', event.data, false);
        }
    };

    channel.onerror = (error) => {
        console.error('DataChannel ошибка:', error);
        updateStatus('Ошибка DataChannel: ' + error.message, 'error');
    };
}

function handleImageChunk(data) {
    if (imageChunks[data.id]) {
        const imgData = imageChunks[data.id];
        const chunkData = new Uint8ClampedArray(data.data);
        const startIndex = data.index * 64000;

        imgData.data.set(chunkData, startIndex);
        imgData.received++;

        if (imgData.received === imgData.total) {
            displayImageMessage('Партнер', imgData.data, false);
            saveMessageToDB({
                type: 'image',
                sender: 'partner',
                data: Array.from(imgData.data),
                width: imgData.width,
                height: imgData.height
            });
            delete imageChunks[data.id];
        }
    }
}

function handleFileChunk(data) {
    if (fileChunks[data.id]) {
        const fileData = fileChunks[data.id];
        fileData.data.push(...data.data);
        fileData.received++;

        if (fileData.received === fileData.total) {
            const fileBlob = new Blob([new Uint8Array(fileData.data)], { type: fileData.fileType });
            displayFileMessage('Партнер', {
                name: fileData.fileName,
                size: fileData.fileSize,
                type: fileData.fileType,
                blob: fileBlob
            }, false);

            saveMessageToDB({
                type: 'file',
                sender: 'partner',
                fileData: {
                    name: fileData.fileName,
                    size: fileData.fileSize,
                    type: fileData.fileType,
                    data: fileData.data
                }
            });
            delete fileChunks[data.id];
        }
    }
}

function sendMessage() {
    const message = messageInput.value.trim();
    if (!message || !dataChannel || dataChannel.readyState !== 'open') return;

    const messageData = {
        message: message,
        timestamp: new Date().toISOString(),
        type: 'text'
    };

    dataChannel.send(JSON.stringify(messageData));
    addMessage('Вы', message, true);
    saveMessageToDB({
        type: 'text',
        sender: 'me',
        content: message
    });
    messageInput.value = '';
    timeEstimate.textContent = '';
    messageInput.style.height = 'auto';
}

async function sendFile(file) {
    if (!dataChannel || dataChannel.readyState !== 'open') {
        alert('Data channel не готов');
        return;
    }

    isSendingFile = true;

    const fileId = Date.now().toString();
    const CHUNK_SIZE = 16000;
    const fileBuffer = await file.arrayBuffer();
    const totalChunks = Math.ceil(fileBuffer.byteLength / CHUNK_SIZE);

    const fileMessage = {
        type: 'file_start',
        id: fileId,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        chunkCount: totalChunks
    };

    const messageElement = displayFileMessage('Вы', {
        name: file.name,
        size: file.size,
        type: file.type,
        progress: 0
    }, true);

    dataChannel.send(JSON.stringify(fileMessage));

    for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, fileBuffer.byteLength);
        const chunk = new Uint8Array(fileBuffer.slice(start, end));

        const chunkMessage = {
            type: 'file_chunk',
            id: fileId,
            index: i,
            data: Array.from(chunk)
        };

        dataChannel.send(JSON.stringify(chunkMessage));

        const progress = ((i + 1) / totalChunks) * 100;
        updateFileProgress(messageElement, progress);

        await new Promise(resolve => setTimeout(resolve, 10));
    }

    const fileBlob = new Blob([fileBuffer], { type: file.type });
    saveMessageToDB({
        type: 'file',
        sender: 'me',
        fileData: {
            name: file.name,
            size: file.size,
            type: file.type,
            data: Array.from(new Uint8Array(fileBuffer))
        }
    });

    isSendingFile = false;
    updateFileProgress(messageElement, 100);
}

function sendPhoto() {
    if (!dataChannel || dataChannel.readyState !== 'open') {
        alert('Data channel не готов');
        return;
    }

    if (isSendingFile) {
        alert('Дождитесь окончания отправки текущего файла');
        return;
    }

    isSendingFile = true;

    const img = photoContext.getImageData(0, 0, photoCanvas.width, photoCanvas.height);
    const CHUNK_LEN = 64000;
    const len = img.data.byteLength;
    const n = Math.floor(len / CHUNK_LEN);

    const transferId = Date.now().toString();

    const metadata = {
        type: 'image_start',
        id: transferId,
        width: photoCanvas.width,
        height: photoCanvas.height,
        totalBytes: len,
        chunkCount: n + (len % CHUNK_LEN ? 1 : 0)
    };

    dataChannel.send(JSON.stringify(metadata));

    for (let i = 0; i < n; i++) {
        const start = i * CHUNK_LEN;
        const end = (i + 1) * CHUNK_LEN;
        const chunk = img.data.subarray(start, end);

        const chunkData = {
            type: 'image_chunk',
            id: transferId,
            index: i,
            data: Array.from(chunk)
        };

        dataChannel.send(JSON.stringify(chunkData));
    }

    if (len % CHUNK_LEN) {
        const start = n * CHUNK_LEN;
        const chunk = img.data.subarray(start);

        const chunkData = {
            type: 'image_chunk',
            id: transferId,
            index: n,
            data: Array.from(chunk)
        };

        dataChannel.send(JSON.stringify(chunkData));
    }

    displayImageMessage('Вы', img.data, true);
    saveMessageToDB({
        type: 'image',
        sender: 'me',
        data: Array.from(img.data),
        width: photoCanvas.width,
        height: photoCanvas.height
    });

    isSendingFile = false;
    photoCanvas.style.display = 'none';
}

function createImageMessage(sender, imageData, isOwn, timestamp) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'message-avatar';
    avatarDiv.textContent = isOwn ? 'В' : 'П';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    const headerDiv = document.createElement('div');
    headerDiv.className = 'message-header';

    const authorSpan = document.createElement('span');
    authorSpan.className = 'message-author';
    authorSpan.textContent = sender;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-time';
    timeSpan.textContent = new Date(timestamp).toLocaleTimeString();

    headerDiv.appendChild(authorSpan);
    headerDiv.appendChild(timeSpan);

    const canvas = document.createElement('canvas');
    canvas.width = photoCanvas.width;
    canvas.height = photoCanvas.height;
    canvas.className = 'image-preview';

    const context = canvas.getContext('2d');
    const img = context.createImageData(photoCanvas.width, photoCanvas.height);

    if (imageData instanceof Uint8ClampedArray) {
        img.data.set(imageData);
    } else {
        img.data.set(new Uint8ClampedArray(imageData));
    }

    context.putImageData(img, 0, 0);

    contentDiv.appendChild(headerDiv);
    contentDiv.appendChild(canvas);

    messageDiv.appendChild(avatarDiv);
    messageDiv.appendChild(contentDiv);

    return messageDiv;
}

function displayImageMessage(sender, imageData, isOwn) {
    const messageDiv = createImageMessage(sender, imageData, isOwn, new Date().toISOString());
    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function displayFileMessage(sender, fileInfo, isOwn) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'message-avatar';
    avatarDiv.textContent = isOwn ? 'В' : 'П';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    const headerDiv = document.createElement('div');
    headerDiv.className = 'message-header';

    const authorSpan = document.createElement('span');
    authorSpan.className = 'message-author';
    authorSpan.textContent = sender;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-time';
    timeSpan.textContent = new Date().toLocaleTimeString();

    headerDiv.appendChild(authorSpan);
    headerDiv.appendChild(timeSpan);

    const fileDiv = document.createElement('div');
    fileDiv.className = 'file-message';

    const fileIcon = document.createElement('div');
    fileIcon.className = 'file-icon';
    fileIcon.innerHTML = '<i class="fas fa-file"></i>';

    const fileInfoDiv = document.createElement('div');
    fileInfoDiv.className = 'file-info';

    const fileName = document.createElement('div');
    fileName.className = 'file-name';
    fileName.textContent = fileInfo.name;

    const fileSize = document.createElement('div');
    fileSize.className = 'file-size';
    fileSize.textContent = formatFileSize(fileInfo.size);

    fileInfoDiv.appendChild(fileName);
    fileInfoDiv.appendChild(fileSize);

    fileDiv.appendChild(fileIcon);
    fileDiv.appendChild(fileInfoDiv);

    if (fileInfo.progress !== undefined && fileInfo.progress < 100) {
        const progressContainer = document.createElement('div');
        progressContainer.className = 'progress-container';

        const progressBar = document.createElement('div');
        progressBar.className = 'progress-bar';
        progressBar.style.width = fileInfo.progress + '%';

        progressContainer.appendChild(progressBar);
        fileDiv.appendChild(progressContainer);
    } else if (fileInfo.blob) {
        const downloadButton = document.createElement('button');
        downloadButton.className = 'action-button';
        downloadButton.innerHTML = '<i class="fas fa-download"></i>';
        downloadButton.onclick = () => {
            const url = URL.createObjectURL(fileInfo.blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileInfo.name;
            a.click();
            URL.revokeObjectURL(url);
        };
        fileDiv.appendChild(downloadButton);
    }

    contentDiv.appendChild(headerDiv);
    contentDiv.appendChild(fileDiv);

    messageDiv.appendChild(avatarDiv);
    messageDiv.appendChild(contentDiv);

    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    return messageDiv;
}

function createTextMessage(sender, message, isOwn, timestamp) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'message-avatar';
    avatarDiv.textContent = isOwn ? 'В' : 'П';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    const headerDiv = document.createElement('div');
    headerDiv.className = 'message-header';

    const authorSpan = document.createElement('span');
    authorSpan.className = 'message-author';
    authorSpan.textContent = sender;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-time';
    timeSpan.textContent = new Date(timestamp).toLocaleTimeString();

    headerDiv.appendChild(authorSpan);
    headerDiv.appendChild(timeSpan);

    const textDiv = document.createElement('div');
    textDiv.className = 'message-text';
    textDiv.textContent = message;

    contentDiv.appendChild(headerDiv);
    contentDiv.appendChild(textDiv);

    messageDiv.appendChild(avatarDiv);
    messageDiv.appendChild(contentDiv);

    return messageDiv;
}

function addMessage(sender, message, isOwn) {
    const messageDiv = createTextMessage(sender, message, isOwn, new Date().toISOString());
    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function updateFileProgress(messageElement, progress) {
    const progressBar = messageElement.querySelector('.progress-bar');
    if (progressBar) {
        progressBar.style.width = progress + '%';
    }
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function downloadKaeFile(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function addSystemMessage(message) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'message-avatar';
    avatarDiv.innerHTML = '<i class="fas fa-info-circle"></i>';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    const textDiv = document.createElement('div');
    textDiv.className = 'message-text';
    textDiv.style.color = '#72767d';
    textDiv.textContent = message;

    contentDiv.appendChild(textDiv);

    messageDiv.appendChild(avatarDiv);
    messageDiv.appendChild(contentDiv);

    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function updateStatus(message, type = '') {
    statusDiv.textContent = `Статус: ${message}`;
    statusDiv.className = `status ${type}`;
}

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        if (e.shiftKey) {
            return;
        } else {
            e.preventDefault();
            sendMessage();
        }
    }
});

messageInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';

    if (this.scrollHeight > 200) {
        this.style.overflowY = 'auto';
    } else {
        this.style.overflowY = 'hidden';
    }
});

document.getElementById('connectionChannel').addEventListener('click', function () {
    connectionPanel.classList.remove('hidden');
    chatInputContainer.classList.add('hidden');
});

document.querySelector('.channel-item.active').addEventListener('click', function () {
    if (peerConnection && peerConnection.iceConnectionState === 'connected') {
        connectionPanel.classList.add('hidden');
        chatInputContainer.classList.remove('hidden');
    }
});

openDB().then(() => {
    console.log('База данных готова');
}).catch(error => {
    console.error('Ошибка инициализации базы данных:', error);
});
