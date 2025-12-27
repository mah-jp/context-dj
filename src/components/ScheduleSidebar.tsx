import { useRef, useEffect } from 'react';
import styles from '../app/page.module.css';
import { Clock, Trash2 } from 'lucide-react';
import { ScheduleItem } from '../lib/ai';

interface ScheduleSidebarProps {
    schedule: ScheduleItem[];
    currentQuery: string | null;
    onRemoveItem: (index: number) => void;
}

export default function ScheduleSidebar({ schedule, currentQuery, onRemoveItem }: ScheduleSidebarProps) {
    return (
        <div className={styles.sidebar}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', color: 'var(--primary)', fontWeight: 600 }}>
                <Clock size={20} />
                <span>My Schedule</span>
            </div>
            {schedule.length > 0 ? schedule.map((item, i) => {
                const isActive = currentQuery === ((item.queries ? item.queries.join('|') : (item.query || '')) + (item.priorityTrack ? '|' + item.priorityTrack : ''));
                return (
                    <div
                        key={i}
                        className={styles.scheduleItem}
                        style={{
                            position: 'relative',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'flex-start',
                            borderLeft: isActive ? '3px solid var(--primary)' : '3px solid transparent',
                            background: isActive ? 'rgba(3, 218, 198, 0.05)' : undefined
                        }}
                    >
                        <div style={{ flex: 1, marginRight: '8px' }}>
                            <div className={styles.scheduleTime} style={{ color: isActive ? 'var(--primary)' : undefined }}>{item.start} - {item.end}</div>
                            <div className={styles.scheduleQuery}>
                                {item.queries ? item.queries.join(', ') : item.query}
                            </div>
                        </div>
                        <button
                            onClick={() => onRemoveItem(i)}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: '#b3b3b3',
                                cursor: 'pointer',
                                padding: '4px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                transition: 'color 0.2s'
                            }}
                            title="Remove schedule item"
                            onMouseEnter={(e) => e.currentTarget.style.color = '#ef4444'}
                            onMouseLeave={(e) => e.currentTarget.style.color = '#b3b3b3'}
                        >
                            <Trash2 size={14} />
                        </button>
                    </div>
                );
            }) : (
                <div style={{ color: '#555', fontSize: '0.9rem', padding: '1rem' }}>No active schedule.</div>
            )}
        </div>
    );
}
