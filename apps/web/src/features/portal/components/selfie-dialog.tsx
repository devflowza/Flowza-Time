import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, ImageUp, RotateCcw, Send } from 'lucide-react';
import { SELFIE_MAX_BYTES, type SelfPunchDirection } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { PA_NS } from '../attendance-i18n';
import { usePunchMutations } from '../attendance-api';
import type { GeoFix } from '../geo';

const MAX_EDGE = 720;

/** Re-encode an image (camera frame or chosen file) as a JPEG no wider/taller than MAX_EDGE; null when canvas is unavailable. */
async function toJpeg(source: CanvasImageSource, width: number, height: number): Promise<Blob | null> {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85));
}

/**
 * The selfie check-in: a photo of the employee (front camera, or a chosen file where the camera is not available) sent with
 * the location for a manager to review. It becomes a punch — at the time it was submitted — only once approved.
 */
export function SelfieDialog({ open, onOpenChange, direction, fix, onSent }: { open: boolean; onOpenChange: (o: boolean) => void; direction: SelfPunchDirection; fix: GeoFix | null; onSent?: () => void }) {
  const { t } = useTranslation(PA_NS);
  const { t: tc } = useTranslation();
  const { selfie } = usePunchMutations();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraFailed, setCameraFailed] = useState(false);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the preview's object URL follows the photo; it is revoked when the photo changes or the dialog unmounts
  const previewUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const stop = useCallback(() => { streamRef.current?.getTracks().forEach((tr) => tr.stop()); streamRef.current = null; setStream(null); }, []);
  const startCamera = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) { setCameraFailed(true); return; }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 } }, audio: false });
      streamRef.current = s;
      setStream(s);
    } catch { setCameraFailed(true); }
  }, []);

  useEffect(() => { if (videoRef.current && stream) { videoRef.current.srcObject = stream; void videoRef.current.play().catch(() => undefined); } }, [stream]);
  // the page mounts the dialog only while it is open: leaving it releases the camera
  useEffect(() => () => { streamRef.current?.getTracks().forEach((tr) => tr.stop()); streamRef.current = null; }, []);

  const capture = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const blob = await toJpeg(v, v.videoWidth, v.videoHeight);
    if (blob) { setPhoto(blob); stop(); }
  };
  const choose = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { setError(t('checkin.selfie.badType')); return; }
    if (file.size <= SELFIE_MAX_BYTES) { setPhoto(file); return; }
    // too large as taken: shrink it on the device before sending
    try {
      const bitmap = typeof createImageBitmap === 'function' ? await createImageBitmap(file) : null;
      const blob = bitmap ? await toJpeg(bitmap, bitmap.width, bitmap.height) : null;
      if (blob && blob.size <= SELFIE_MAX_BYTES) { setPhoto(blob); return; }
    } catch { /* fall through */ }
    setError(t('checkin.selfie.tooLarge'));
  };
  const send = () => {
    if (!photo) return;
    selfie.mutate({ photo, direction, lat: fix?.lat, lng: fix?.lng, accuracy: fix?.accuracy }, {
      onSuccess: () => { toast.success(t('checkin.selfie.sent')); onSent?.(); onOpenChange(false); },
      onError: toastError,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{direction === 'in' ? t('checkin.selfie.titleIn') : t('checkin.selfie.titleOut')}</DialogTitle>
          <DialogDescription>{t('checkin.selfie.hint')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg border bg-muted">
            {previewUrl ? <img src={previewUrl} alt={t('checkin.selfie.previewAlt')} className="size-full object-cover" data-testid="selfie-preview" />
              : stream ? <video ref={videoRef} className="size-full -scale-x-100 object-cover" playsInline muted aria-label={t('checkin.selfie.cameraAlt')} />
              : <Camera className="size-10 text-muted-foreground" aria-hidden />}
          </div>
          {cameraFailed && !photo ? <p className="text-xs text-muted-foreground">{t('checkin.selfie.noCamera')}</p> : null}
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          {!fix ? <p className="text-xs text-muted-foreground">{t('checkin.selfie.noLocation')}</p> : null}
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" capture="user" className="sr-only" aria-label={t('checkin.selfie.upload')} data-testid="selfie-file" onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
          <div className="flex flex-wrap gap-2">
            {photo ? <Button type="button" variant="outline" size="sm" onClick={() => { setPhoto(null); if (!cameraFailed) void startCamera(); }}><RotateCcw /> {t('checkin.selfie.retake')}</Button>
              : stream ? <Button type="button" size="sm" onClick={() => void capture()}><Camera /> {t('checkin.selfie.capture')}</Button>
              : !cameraFailed ? <Button type="button" variant="outline" size="sm" onClick={() => void startCamera()}><Camera /> {t('checkin.selfie.start')}</Button> : null}
            {!photo ? <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}><ImageUp /> {t('checkin.selfie.upload')}</Button> : null}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
          <Button type="button" disabled={!photo} loading={selfie.isPending} onClick={send}><Send /> {t('checkin.selfie.send')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
