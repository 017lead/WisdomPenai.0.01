
  // Global Variables
  const chatbox = document.getElementById('chat-messages');
  const userInput = document.getElementById('user-input');
  const sendButton = document.getElementById('send');
  const fileUpload = document.getElementById('file-upload');
  const fileList = document.getElementById('file-list');
  const overlaychat = document.getElementById('overlaychat');
  const videoUrlButton = document.getElementById('video-url-button');
  const urlInputContainer = document.getElementById('url-input-container');
  const urlInput = document.getElementById('url-input');
  
  let uploadedFiles = [];
  let isArabic = false;
  let urlAdded = '';

  // Dark Mode Preference
  function checkUserPreference() {
    const darkModeCookie = getCookie('darkMode');
    if (darkModeCookie === 'true') {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
  }

  function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
  }

  window.addEventListener('load', checkUserPreference);

  // Language Toggle
  function toggleLanguage() {
    isArabic = !isArabic;
    const chatContainer = document.querySelector('.chat-container');
    const testElement = document.querySelector('.test');
    const languageToggle = document.getElementById('languageToggle');

    if (isArabic) {
      chatContainer.classList.add('rtl');
      sendButton.textContent = 'ابحث';
      testElement.textContent = 'اختبار تجريبي: 0.7.9';
      userInput.setAttribute('placeholder', 'اكتب سؤالك هنا...');
      languageToggle.textContent = 'English';
      document.querySelectorAll('.chat-messages li').forEach(li => {
        if (li.textContent.includes('You:')) {
          li.textContent = li.textContent.replace('You:', 'أنت:');
        }
      });
    } else {
      chatContainer.classList.remove('rtl');
      sendButton.textContent = 'Find';
      testElement.textContent = 'Beta Testing: 0.7.9';
      userInput.setAttribute('placeholder', 'Type Your Questions Here..');
      languageToggle.textContent = 'عربي';
      document.querySelectorAll('.chat-messages li').forEach(li => {
        if (li.textContent.includes('أنت:')) {
          li.textContent = li.textContent.replace('أنت:', 'You:');
        }
      });
    }
  }

  document.getElementById('languageToggle').addEventListener('click', toggleLanguage);

  // Textarea Auto-Resize
  userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
  });

  // Enable/Disable Send Button
  document.addEventListener('DOMContentLoaded', function() {
    sendButton.disabled = true;
    userInput.addEventListener('input', function() {
      sendButton.disabled = this.value.trim() === '' && uploadedFiles.length === 0 && !urlAdded;
    });
  });

  // Quran Reference Formatter
  function formatQuranReferences(text) {
    if (!text) return text;
    const pattern = /Quran\s+(\d+):(\d+(?:-\d+)?)/g;
    return text.replace(pattern, (match, surah, verse) => {
      return `<a href="https://www.google.com/search?q=Quran+Surah+${surah}+Verse+${verse}" target="_blank" rel="noopener noreferrer">${match}</a>`;
    });
  }

  // Chat Functionality
  function addMessage(sender, message, isUser = false) {
    const messageElement = document.createElement('li');
    messageElement.classList.add(isUser ? 'user-message' : 'assistant-message');
    const formattedMessage = isUser ? message : formatQuranReferences(message);
    messageElement.innerHTML = isUser ? message : formattedMessage;
    chatbox.appendChild(messageElement);
    chatbox.scrollTop = chatbox.scrollHeight;
    return messageElement;
  }

  function createTypingAnimation() {
    const words = ['Loading', 'Finding', 'Looking', 'Thinking'];
    const randomWord = words[Math.floor(Math.random() * words.length)];
    const typingElement = document.createElement('div');
    typingElement.className = 'typing-animation';
    typingElement.innerHTML = `${randomWord} <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>`;
    return typingElement;
  }

  async function sendMessage() {
    const message = userInput.value.trim();
    if (message || uploadedFiles.length > 0 || urlAdded) {
      addMessage('You', message, true);
      userInput.value = '';
      sendButton.disabled = true;
      userInput.disabled = true;

      const assistantMessage = addMessage('Assistant', '', false);
      const typingAnimation = createTypingAnimation();
      assistantMessage.appendChild(typingAnimation);

      try {
        const formData = new FormData();
        formData.append('message', message);
        uploadedFiles.forEach(item => {
          formData.append('files', item.file);
        });
        if (urlAdded) {
          formData.append('url', urlAdded);
        }

        const backendUrl = 'https://wisdompenai-0-01.onrender.com';
        const response = await fetch(`${backendUrl}/chat`, {
          method: 'POST',
          body: formData
        });

        if (!response.ok) {
          throw new Error('Network response was not ok');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let assistantResponse = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[END]') {
                break;
              } else {
                assistantResponse += data + ' ';
                assistantMessage.innerHTML = formatQuranReferences(assistantResponse);
              }
            }
          }
          chatbox.scrollTop = chatbox.scrollHeight;
        }
        assistantMessage.innerHTML = formatQuranReferences(assistantResponse.trim());
      } catch (error) {
        console.error('Error:', error);
        assistantMessage.innerHTML = '<strong>Assistant:</strong> An error occurred while processing your request.';
      } finally {
        sendButton.disabled = false;
        userInput.disabled = false;
        uploadedFiles = [];
        fileList.innerHTML = '';
        urlAdded = '';
        urlInput.value = '';
        urlInputContainer.style.display = 'none';
      }
    }
  }

  sendButton.addEventListener('click', sendMessage);
  userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Video/URL Button Functionality
  videoUrlButton.addEventListener('click', () => {
    const isVisible = urlInputContainer.style.display === 'block';
    urlInputContainer.style.display = isVisible ? 'none' : 'block';
    videoUrlButton.classList.toggle('active', !isVisible);
    if (!isVisible) {
      urlInput.focus();
    }
  });

  urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      urlAdded = urlInput.value.trim();
      if (urlAdded) {
        urlInputContainer.style.display = 'none';
        userInput.focus();
      }
    }
  });

  // Initial Message
  addMessage('Assistant', 'Assalamu alaikum! How can I assist you today? You can also upload images or text files, or share a YouTube video URL.', false);

  // File Upload Handling
  fileUpload.addEventListener('change', function(e) {
    const files = e.target.files;
    if (files.length > 0) {
      handleFiles(files);
    }
  });

  overlaychat.addEventListener('click', function(e) {
    if (e.target === overlaychat) {
      userInput.focus();
    }
  });

  function handleFiles(files) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/') || file.type === 'text/plain' || file.name.endsWith('.txt')) {
        if (file.size <= 5 * 1024 * 1024) {
          processFile(file);
        } else {
          alert('File size exceeds 5MB limit.');
        }
      } else {
        alert('Only image and text files are supported.');
      }
    }
    setTimeout(() => userInput.focus(), 100);
  }

  function processFile(file) {
    const fileId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    uploadedFiles.push({ id: fileId, file: file });
    addFileToUI(file, fileId);
  }

  function addFileToUI(file, fileId) {
    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    fileItem.setAttribute('data-file-id', fileId);
    const fileIcon = file.type.startsWith('image/') ? 'image' : 'description';
    const fileTypeClass = file.type.startsWith('image/') ? 'file-type-img' : 'file-type-txt';
    const fileTypeText = file.type.startsWith('image/') ? file.type.split('/')[1].toUpperCase() : 'TXT';

    const fileHeader = document.createElement('div');
    fileHeader.className = 'file-item-header';
    fileHeader.innerHTML = `
      <span class="material-icons">${fileIcon}</span>
      <span class="file-name">${file.name}</span>
      <span class="file-type-indicator ${fileTypeClass}">${fileTypeText}</span>
      <span class="material-icons remove-file" data-file-id="${fileId}">close</span>
    `;
    fileItem.appendChild(fileHeader);
    fileList.appendChild(fileItem);

    fileItem.querySelector('.remove-file').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeFile(fileId);
    });

    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = function(e) {
        const previewContainer = document.createElement('div');
        previewContainer.className = 'file-preview-container';
        const preview = document.createElement('img');
        preview.src = e.target.result;
        preview.className = 'file-preview';
        previewContainer.appendChild(preview);
        fileItem.appendChild(previewContainer);
      };
      reader.readAsDataURL(file);
    }
  }

  function removeFile(fileId) {
    uploadedFiles = uploadedFiles.filter(item => item.id !== fileId);
    const fileItem = document.querySelector(`[data-file-id="${fileId}"]`);
    if (fileItem) fileItem.remove();
  }
