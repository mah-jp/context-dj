import { X, Terminal } from 'lucide-react';
import { usePlayerLogs } from '../context/PlayerContext';

interface ProcessLogViewerProps {
    logs?: string[];
    onClose: () => void;
}

export default function ProcessLogViewer({ logs: logsProp, onClose }: ProcessLogViewerProps) {
    const { logs: contextLogs } = usePlayerLogs();
    const logs = logsProp ?? contextLogs;


    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.7)',
            zIndex: 3000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(4px)'
        }}>
            <div style={{
                background: '#1e1e1e',
                width: '90%',
                maxWidth: '600px',
                height: '80vh',
                borderRadius: '8px',
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
                border: '1px solid #333'
            }}>
                {/* Header */}
                <div style={{
                    padding: '16px',
                    borderBottom: '1px solid #333',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: '#252525',
                    borderRadius: '8px 8px 0 0'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--primary)', fontWeight: 'bold' }}>
                        <Terminal size={20} />
                        <span>DJ Process Log</span>
                    </div>
                    <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer' }}>
                        <X size={20} />
                    </button>
                </div>

                {/* Log Content */}
                <div style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: '16px',
                    fontFamily: 'monospace',
                    fontSize: '0.85rem',
                    color: '#ccc',
                    lineHeight: 1.5,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px'
                }}>
                    {logs.length > 0 ? logs.map((log, i) => (
                        <div key={`${log}-${i}`} style={{
                            borderBottom: '1px solid #2a2a2a',
                            paddingBottom: '4px',
                            color: log.includes('❌') || log.includes('⚠️') ? '#cf6679' :
                                log.includes('✅') ? 'var(--primary)' :
                                    log.includes('▶️') ? '#bb86fc' : '#ccc'
                        }}>
                            {log}
                        </div>
                    )) : (
                        <div style={{ color: '#666', fontStyle: 'italic', textAlign: 'center', marginTop: '20px' }}>
                            Waiting for DJ activity...
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
