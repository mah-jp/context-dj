import styles from '../app/page.module.css';
import { Trash2 } from 'lucide-react';
import { ScheduleItem } from '../lib/types';
import { isScheduleItemPast, getScheduleItemSignature } from '../lib/dj-utils';

interface ScheduleSidebarProps {
    schedule: ScheduleItem[];
    currentQuery: string | null;
    onRemoveItem: (index: number) => void;
    onRecallItem: (item: ScheduleItem) => void;
}

export default function ScheduleSidebar({ schedule, currentQuery, onRemoveItem, onRecallItem }: ScheduleSidebarProps) {
    return (
        <div className={styles.sidebar}>
            {schedule.length > 0 ? schedule.map((item, i) => {
                const past = isScheduleItemPast(item);
                const isActive = !past && currentQuery === getScheduleItemSignature(item);

                return (
                    <div
                        key={`${item.start}-${item.end}-${i}`}
                        className={`${styles.scheduleItem} ${past ? styles.pastItem : ''}`}
                        onClick={() => onRecallItem(item)}
                        style={{
                            position: 'relative',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'flex-start',
                            borderLeft: isActive ? '3px solid var(--primary)' : '3px solid transparent',
                            background: isActive ? 'rgba(3, 218, 198, 0.05)' : undefined,
                            opacity: past ? 0.5 : 1,
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                        }}
                        title="Click to recall this context / クリックでこの文脈を再利用"
                    >
                        <div style={{ flex: 1, marginRight: '8px' }}>
                            <div className={styles.scheduleTime} style={{ color: isActive ? 'var(--primary)' : undefined }}>{item.start} - {item.end}</div>
                            <div className={styles.scheduleQuery}>
                                {item.queries ? item.queries.join(', ') : item.query}
                            </div>
                        </div>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemoveItem(i);
                            }}
                            className={styles.scheduleDeleteBtn}
                            title="Remove schedule item"
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
