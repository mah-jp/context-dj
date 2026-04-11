'use client';

import { useEffect, useState } from 'react';
import styles from '../app/page.module.css';

interface DynamicBackgroundProps {
    imageUrl?: string;
}

export default function DynamicBackground({ imageUrl }: DynamicBackgroundProps) {
    const [prevImage, setPrevImage] = useState<string | undefined>(undefined);
    const [currentImage, setCurrentImage] = useState<string | undefined>(imageUrl);
    const [isTransitioning, setIsTransitioning] = useState(false);

    useEffect(() => {
        if (imageUrl !== currentImage) {
            setPrevImage(currentImage);
            setCurrentImage(imageUrl);
            setIsTransitioning(true);
            
            const timer = setTimeout(() => {
                setIsTransitioning(false);
            }, 1500); // Match CSS transition duration
            
            return () => clearTimeout(timer);
        }
    }, [imageUrl]);

    if (!currentImage && !prevImage) return <div className={styles.bgBaseLayer} />;

    return (
        <div className={styles.immersiveBgContainer}>
            {/* Base Dark Layer */}
            <div className={styles.bgBaseLayer} />
            
            {/* Previous Image Layer (Fading Out) */}
            {prevImage && (
                <div 
                    className={`${styles.bgArtLayer} ${isTransitioning ? styles.fadeOut : ''}`}
                    style={{ backgroundImage: `url(${prevImage})` }}
                />
            )}
            
            {/* Current Image Layer (Fading In) */}
            {currentImage && (
                <div 
                    className={`${styles.bgArtLayer} ${isTransitioning ? styles.fadeIn : ''}`}
                    style={{ backgroundImage: `url(${currentImage})` }}
                />
            )}
            
            {/* Vignette / Overlay to ensure readability */}
            <div className={styles.bgOverlay} />
        </div>
    );
}
