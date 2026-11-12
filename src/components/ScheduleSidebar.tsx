import styles from '../app/page.module.css';
import { Trash2, Clock } from 'lucide-react';
import { ScheduleItem } from '../lib/types';
import { getScheduleItemDisplayStatus } from '../lib/dj-utils';

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
                const displayStatus = getScheduleItemDisplayStatus(schedule, i, currentQuery);
                const isActive = displayStatus === 'active';
                const isStandby = displayStatus === 'standby';
                const past = displayStatus === 'past';

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
                            borderLeft: isActive
                                ? '3px solid var(--primary)'
                                : isStandby
                                    ? '3px solid #f59e0b'
                                    : '3px solid transparent',
                            background: isActive
                                ? 'rgba(3, 218, 198, 0.05)'
                                : isStandby
                                    ? 'rgba(245, 158, 11, 0.06)'
                                    : undefined,
                            opacity: past ? 0.5 : 1,
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                        }}
                        title="Click to recall this context / クリックでこの文脈を再利用"
                    >
                        <div
                            role="button"
                            tabIndex={0}
                            aria-label={`Recall schedule ${item.start} - ${item.end}`}
                            className={styles.scheduleRecallArea}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    onRecallItem(item);
                                }
                            }}
                            style={{ flex: 1, marginRight: '8px', borderRadius: '4px' }}
                        >
                            <div
                                className={styles.scheduleTime}
                                style={{
                                    color: isActive ? 'var(--primary)' : isStandby ? '#fbbf24' : undefined,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                }}
                            >
                                <span>{item.start} - {item.end}</span>
                                {isStandby && (
                                    <span
                                        style={{
                                            fontSize: '0.68rem',
                                            padding: '1px 6px',
                                            borderRadius: '999px',
                                            background: 'rgba(245, 158, 11, 0.16)',
                                            border: '1px solid rgba(245, 158, 11, 0.4)',
                                            color: '#fbbf24',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: '3px',
                                        }}
                                        title={`Scheduled to start automatically at ${item.start} (${item.start}に自動開始)`}
                                    >
                                        <Clock size={10} />
                                        待機中
                                    </span>
                                )}
                            </div>
                            <div className={styles.scheduleQuery}>
                                {item.queries ? item.queries.join(', ') : item.query}
                            </div>
                        </div>
                        <button
                            type="button"
                            aria-label={`Remove schedule ${item.start} - ${item.end}`}
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
