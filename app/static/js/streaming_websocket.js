/**
 * WebSocket Client for Live Streaming Session Updates
 * Connects to Flask-SocketIO backend for real-time session monitoring
 */

class StreamingWebSocket {
    constructor() {
        this.socket = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000; // Start with 2 seconds
        this.isConnected = false;
        this.currentView = 'merged'; // Default view mode
    }

    /**
     * Initialize and connect to WebSocket
     */
    connect() {
        console.log('[StreamingWS] Connecting to WebSocket...');

        // Initialize Socket.IO connection
        this.socket = io('/streaming', {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionDelay: this.reconnectDelay,
            reconnectionAttempts: this.maxReconnectAttempts
        });

        this.setupEventHandlers();
    }

    /**
     * Setup all WebSocket event handlers
     */
    setupEventHandlers() {
        // Connection established
        this.socket.on('connect', () => {
            console.log('[StreamingWS] Connected to server');
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.updateConnectionStatus('connected');
        });

        // Connection status from server
        this.socket.on('connection_status', (data) => {
            console.log('[StreamingWS] Connection status:', data);
            // Removed notification - using indicator instead
        });

        // Session update from server
        this.socket.on('session_update', (data) => {
            console.log('[StreamingWS] Received session update:', data);
            this.handleSessionUpdate(data);
        });

        // Update requested acknowledgment
        this.socket.on('update_requested', (data) => {
            console.log('[StreamingWS] Update requested:', data);
        });

        // Disconnection
        this.socket.on('disconnect', (reason) => {
            console.log('[StreamingWS] Disconnected:', reason);
            this.isConnected = false;
            this.updateConnectionStatus('disconnected');

            if (reason === 'io server disconnect') {
                // Server disconnected us, try to reconnect
                this.socket.connect();
            }
        });

        // Connection error
        this.socket.on('connect_error', (error) => {
            console.error('[StreamingWS] Connection error:', error);
            this.reconnectAttempts++;

            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                console.error('[StreamingWS] Max reconnection attempts reached');
                this.showNotification('Lost connection to server. Please refresh the page.', 'error');
            }
        });

        // Error from server
        this.socket.on('error', (data) => {
            console.error('[StreamingWS] Server error:', data);
            this.showNotification(data.message || 'An error occurred', 'error');
        });

        // Pong response (for keep-alive)
        this.socket.on('pong', (data) => {
            console.log('[StreamingWS] Pong received');
        });
    }

    /**
     * Handle session update data
     */
    handleSessionUpdate(data) {
        const { sessions, summary_stats } = data;

        // Update the streaming container with HTMX
        const container = document.getElementById('streaming-sessions-container');
        if (!container) {
            console.warn('[StreamingWS] Streaming container not found');
            return;
        }

        // Store sessions data for view switching
        window.streamingSessions = sessions;
        window.summaryStats = summary_stats;

        // Trigger HTMX update based on current view
        this.refreshView();
    }

    /**
     * Refresh the current view
     */
    refreshView() {
        const container = document.getElementById('streaming-sessions-container');
        if (!container) return;

        // Get current view mode
        this.currentView = this.getCurrentView();

        // Mark this as a websocket update so timer doesn't reset
        container.setAttribute('data-ws-update', 'true');
        console.log('[StreamingWS] Set data-ws-update flag before HTMX request');

        // Trigger HTMX GET request to refresh partial
        htmx.ajax('GET', `/admin/streaming/partial?view=${this.currentView}`, {
            target: '#streaming-sessions-container',
            swap: 'innerHTML'
        });
    }

    /**
     * Get current view mode from UI
     */
    getCurrentView() {
        const selectedOption = document.querySelector('.streaming-view-option.font-bold');
        return selectedOption ? selectedOption.getAttribute('data-view') : 'merged';
    }

    /**
     * Request manual session update
     */
    requestUpdate(resetTimer = false) {
        if (!this.isConnected) {
            console.warn('[StreamingWS] Cannot request update - not connected');
            this.showNotification('Not connected to server', 'warning');
            return;
        }

        console.log('[StreamingWS] Requesting manual update...');

        // If this is a manual refresh, we might want to reset the timer
        // For now, mark it as a websocket update so timer doesn't reset
        const container = document.getElementById('streaming-sessions-container');
        if (container && !resetTimer) {
            container.setAttribute('data-ws-update', 'true');
            console.log('[StreamingWS] Set data-ws-update flag for manual refresh');
        }

        this.socket.emit('request_update');
    }

    /**
     * Update connection status indicator
     */
    updateConnectionStatus(status) {
        const indicator = document.getElementById('ws-connection-indicator');
        if (!indicator) return;

        if (status === 'connected') {
            indicator.classList.remove('bg-error', 'bg-warning');
            indicator.classList.add('bg-success');
            indicator.title = 'Connected to live updates';
        } else if (status === 'disconnected') {
            indicator.classList.remove('bg-success', 'bg-warning');
            indicator.classList.add('bg-error');
            indicator.title = 'Disconnected from live updates';
        } else {
            indicator.classList.remove('bg-success', 'bg-error');
            indicator.classList.add('bg-warning');
            indicator.title = 'Reconnecting...';
        }
    }

    /**
     * Show notification toast
     */
    showNotification(message, type = 'info') {
        // Check if toast container exists
        let toastContainer = document.getElementById('ws-toast-container');
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.id = 'ws-toast-container';
            toastContainer.className = 'toast toast-top toast-end z-50';
            document.body.appendChild(toastContainer);
        }

        // Create toast
        const toast = document.createElement('div');
        const alertClass = type === 'success' ? 'alert-success' :
                          type === 'error' ? 'alert-error' :
                          type === 'warning' ? 'alert-warning' :
                          'alert-info';

        toast.className = `alert ${alertClass}`;
        toast.innerHTML = `
            <span>${message}</span>
        `;

        toastContainer.appendChild(toast);

        // Auto-remove after 3 seconds
        setTimeout(() => {
            toast.remove();
        }, 3000);
    }

    /**
     * Send periodic ping to keep connection alive
     */
    startKeepAlive() {
        setInterval(() => {
            if (this.isConnected) {
                this.socket.emit('ping', { timestamp: Date.now() });
            }
        }, 25000); // Ping every 25 seconds
    }

    /**
     * Disconnect from WebSocket
     */
    disconnect() {
        if (this.socket) {
            console.log('[StreamingWS] Disconnecting...');
            this.socket.disconnect();
            this.isConnected = false;
        }
    }
}

// Global instance
let streamingWS = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    // Only initialize on streaming page
    if (document.getElementById('streaming-sessions-container')) {
        console.log('[StreamingWS] Initializing WebSocket client...');
        streamingWS = new StreamingWebSocket();
        streamingWS.connect();
        streamingWS.startKeepAlive();

        // Override manual refresh button to use WebSocket
        const refreshButton = document.getElementById('manual-refresh-button');
        if (refreshButton) {
            // Remove HTMX attributes
            refreshButton.removeAttribute('hx-get');
            refreshButton.removeAttribute('hx-target');
            refreshButton.removeAttribute('hx-swap');

            // Add click handler for WebSocket refresh
            refreshButton.addEventListener('click', function(e) {
                e.preventDefault();
                if (streamingWS) {
                    streamingWS.requestUpdate();
                }
            });
        }
    }
});

// Clean up on page unload
window.addEventListener('beforeunload', function() {
    if (streamingWS) {
        streamingWS.disconnect();
    }
});
