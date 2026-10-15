import React from 'react';
import { PRIVACY_NOTICE } from '../lib/constants';

interface PrivacyNoticeProps {
    className?: string;
}

function renderFormattedText(text: string): React.ReactNode[] {
    const parts = text.split(/\*\*(.*?)\*\*/g);
    return parts.map((part, index) =>
        index % 2 === 1 ? <b key={index}>{part}</b> : <React.Fragment key={index}>{part}</React.Fragment>
    );
}

export default function PrivacyNotice({ className }: PrivacyNoticeProps) {
    return (
        <div
            className={className}
            style={!className ? {
                padding: '12px',
                background: 'rgba(3, 218, 198, 0.1)',
                borderLeft: '4px solid #03dac6',
                marginBottom: '20px',
                borderRadius: '4px'
            } : undefined}
        >
            <p style={{ margin: 0, fontSize: '0.88rem', color: '#eee', lineHeight: 1.45 }}>
                🔒 <b>Privacy Notice (プライバシー通知):</b>
                <br />
                {renderFormattedText(PRIVACY_NOTICE.EN)}
                <br />
                <br />
                {renderFormattedText(PRIVACY_NOTICE.JP)}
            </p>
        </div>
    );
}
