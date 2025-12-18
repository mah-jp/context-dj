import Link from 'next/link';
import Image from 'next/image';
import { CheckCircle, XCircle } from 'lucide-react';
import styles from '../app/page.module.css';
import { PRIVACY_NOTICE } from '../lib/constants';

interface OnboardingProps {
    setupStatus: { hasClientId: boolean; hasAiKey: boolean };
    authorized: boolean;
    onLogin: () => void;
}

export default function Onboarding({ setupStatus, authorized, onLogin }: OnboardingProps) {
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
    return (
        <div className={styles.onboardingContainer}>
            <div style={{ margin: 'auto', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ marginBottom: '1.5rem' }}>
                    <Image
                        src={`${basePath}/icon-192x192.png`}
                        alt="ContextDJ Icon"
                        width={128}
                        height={128}
                        style={{ borderRadius: '24px', boxShadow: '0 8px 32px rgba(3, 218, 198, 0.4)' }}
                    />
                </div>
                <h2 style={{ color: '#fff', marginBottom: '1rem' }}>
                    Welcome to ContextDJ!<br />
                    <span style={{ fontSize: '0.8em', fontWeight: 'normal', color: '#888' }}>初期設定ウィザード</span>
                </h2>
                <p className={styles.onboardingDescription}>
                    ContextDJ is your personal <b>AI Music Curator</b>. <br />
                    Simply tell it what you're doing or how you're feeling, and it will curate the perfect soundtrack for your moment.<br />
                    <span style={{ fontSize: '0.9em', color: '#999' }}>
                        (ContextDJは、あなたのための<b>AI音楽キュレーター</b>です。今の気分や状況を伝えるだけで、その瞬間に最適な音楽を選曲してくれます。)
                    </span>
                </p>

                {/* Privacy Notice */}
                <div style={{ padding: '12px', background: 'rgba(3, 218, 198, 0.1)', borderLeft: '4px solid #03dac6', marginBottom: '24px', borderRadius: '4px', maxWidth: '500px', width: '100%' }}>
                    <p style={{ margin: 0, fontSize: '0.85rem', color: '#eee', lineHeight: '1.4' }}>
                        🔒 <b>Privacy Notice (プライバシー通知):</b><br />
                        <span dangerouslySetInnerHTML={{ __html: PRIVACY_NOTICE.EN.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>') }} />
                        <br /><br />
                        <span dangerouslySetInnerHTML={{ __html: PRIVACY_NOTICE.JP.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>') }} />
                    </p>
                </div>

                <div style={{
                    background: '#181818',
                    padding: '24px',
                    borderRadius: '12px',
                    maxWidth: '500px',
                    width: '100%',
                    textAlign: 'left',
                    marginBottom: '2rem',
                    border: '1px solid #333'
                }}>
                    <h3 style={{ marginTop: 0, marginBottom: '16px', color: '#fff', fontSize: '1.1rem' }}>
                        Setup Checklist (設定チェックリスト)
                    </h3>

                    {/* Step 1: Spotify Client ID */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px', opacity: setupStatus.hasClientId ? 0.5 : 1 }}>
                        {setupStatus.hasClientId ? <CheckCircle size={24} color="var(--primary)" /> : <XCircle size={24} color="#cf6679" />}
                        <div style={{ flex: 1 }}>
                            <div style={{ color: setupStatus.hasClientId ? 'var(--primary)' : '#fff', fontWeight: 'bold' }}>1. Spotify App Settings</div>
                            <div style={{ fontSize: '0.85rem', color: '#888' }}>
                                Set your Client ID in Settings.<br />
                                (設定画面でClient IDを入力してください)
                            </div>
                        </div>
                        {!setupStatus.hasClientId && (
                            <Link href="/settings" className={styles.setupBtn}>Settings</Link>
                        )}
                    </div>

                    {/* Step 2: AI API Key */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px', opacity: setupStatus.hasAiKey ? 0.5 : 1 }}>
                        {setupStatus.hasAiKey ? <CheckCircle size={24} color="var(--primary)" /> : <XCircle size={24} color="#cf6679" />}
                        <div style={{ flex: 1 }}>
                            <div style={{ color: setupStatus.hasAiKey ? 'var(--primary)' : '#fff', fontWeight: 'bold' }}>2. AI API Configuration</div>
                            <div style={{ fontSize: '0.85rem', color: '#888' }}>
                                Set valid API Key for OpenAI or Gemini.<br />
                                (AIプロバイダーのAPIキーを設定してください)
                            </div>
                        </div>
                        {(!setupStatus.hasAiKey && setupStatus.hasClientId) && (
                            <Link href="/settings" className={styles.setupBtn}>Settings</Link>
                        )}
                    </div>

                    {/* Step 3: Login */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', opacity: authorized ? 0.5 : 1 }}>
                        {authorized ? <CheckCircle size={24} color="var(--primary)" /> : <div style={{ width: '24px', height: '24px', borderRadius: '50%', border: '2px solid #555', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: '#555' }}>3</div>}
                        <div style={{ flex: 1 }}>
                            <div style={{ color: authorized ? 'var(--primary)' : '#fff', fontWeight: 'bold' }}>3. Login to Spotify</div>
                            <div style={{ fontSize: '0.85rem', color: '#888' }}>
                                Connect your account to start playing.<br />
                                (Spotifyにログインして連携してください)
                            </div>
                        </div>
                        {(!authorized && setupStatus.hasClientId) && (
                            <button onClick={onLogin} className={styles.setupBtn} style={{ background: '#1db954', color: '#fff', border: 'none' }}>
                                Login
                            </button>
                        )}
                    </div>
                </div>

                {!setupStatus.hasClientId && (
                    <p style={{ fontSize: '0.9rem', color: '#666' }}>
                        Please start from Step 1.<br />
                        (まずはステップ1から始めてください)
                    </p>
                )}
            </div>
        </div>
    );
}
