import styles from '../app/page.module.css';
import { Trash2 } from 'lucide-react';
import { ScheduleItem } from '../lib/types';
import {
    isScheduleItemActive,
    isScheduleItemPastInTimeline,
    isWaitingForScheduleStart,
    getScheduleItemSignature,
    resolveEffectiveScheduleItem,
} from '../lib/dj-utils';

interface ScheduleSidebarProps {
    schedule: ScheduleItem[];
    currentQuery: string | null;
    onRemoveItem: (index: number) => void;
    onRecallItem: (item: ScheduleItem) => void;
}

export default function ScheduleSidebar({ schedule, currentQuery, onRemoveItem, onRecallItem }: ScheduleSidebarProps) {
    const waitingForStart = isWaitingForScheduleStart(schedule);
    const effectiveItem = waitingForStart ? null : resolveEffectiveScheduleItem(schedule);
    const hasMatchingCurrentQuery = Boolean(
        currentQuery && schedule.some(s => getScheduleItemSignature(s) === currentQuery)
    );

    return (
        <div className={styles.sidebar}>
            {schedule.length > 0 ? schedule.map((item, i) => {
                const signature = getScheduleItemSignature(item);
                const isActive = !waitingForStart && (
                    hasMatchingCurrentQuery
                        ? currentQuery === signature && (item === effectiveItem || isScheduleItemActive(item))
                        : item === effectiveItem
                );
                const past = !isActive && isScheduleItemPastInTimeline(schedule, i);

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
                            <div className={styles.scheduleTime} style={{ color: isActive ? 'var(--primary)' : undefined }}>{item.start} - {item.end}</div>
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
