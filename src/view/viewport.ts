/**
 * The image-to-screen transform, kept pure and away from the DOM.
 *
 * THIS IS WHERE A MAP VIEW GOES WRONG. The API speaks in IMAGE pixels — `toPixel` returns a
 * position on the source image, `featuresIn` pins at image coordinates — while the DOM speaks in
 * CSS pixels inside a container that is a different size, scrolled, and zoomed. Every bug of the
 * form "the pin is forty pixels left of the place" and "the hover readout disagrees with the pin
 * under the cursor" lives in that conversion, and it is pure arithmetic, so there is no reason for
 * it to be tangled up with an element.
 *
 * ONE DIRECTION IS NOT ENOUGH. `toScreen` and `toImage` must be exact inverses, because the hover
 * readout runs screen-to-image and the pins run image-to-screen, and a user comparing the two is
 * comparing the two directions of this file. A round-trip test is the gate.
 *
 * Fenced from everything but the public API by the phase-5 rule, so it names its coordinates with
 * the published types a third-party consumer would use.
 */
import type { Pixel } from "../api/types";

/** A rectangle in CSS pixels. */
export interface Size {
	readonly width: number;
	readonly height: number;
}

/**
 * How the image sits in the container: uniformly scaled, then offset.
 *
 * `scale` is CSS pixels per image pixel, applied to BOTH axes — a non-uniform scale would make a
 * circle an ellipse and a 1° graticule square a rectangle, which defeats the point of drawing it.
 */
export interface Viewport {
	readonly scale: number;
	/** Where the image's top-left corner sits in the container, in CSS pixels. */
	readonly offsetX: number;
	readonly offsetY: number;
}

export const IDENTITY: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };

/**
 * The viewport that fits the whole image in the container and centres it.
 *
 * Returns the identity for a degenerate image or container rather than dividing by zero: a zero
 * dimension means the image size is unknown, which the coverage layer already refuses to guess at.
 */
export function fitToContainer(image: Size, container: Size): Viewport {
	if (!(image.width > 0 && image.height > 0 && container.width > 0 && container.height > 0)) return IDENTITY;
	const scale = Math.min(container.width / image.width, container.height / image.height);
	return {
		scale,
		offsetX: (container.width - image.width * scale) / 2,
		offsetY: (container.height - image.height * scale) / 2,
	};
}

/** Image pixel to CSS pixel. */
export function toScreen(v: Viewport, p: Pixel): Pixel {
	return { x: p.x * v.scale + v.offsetX, y: p.y * v.scale + v.offsetY };
}

/**
 * CSS pixel to image pixel — the exact inverse of `toScreen`.
 *
 * A zero or non-finite scale would make this a division by zero and put `Infinity` into a
 * coordinate readout, so it is refused rather than propagated.
 */
export function toImage(v: Viewport, p: Pixel): Pixel | null {
	if (!(v.scale > 0) || !Number.isFinite(v.scale)) return null;
	return { x: (p.x - v.offsetX) / v.scale, y: (p.y - v.offsetY) / v.scale };
}

/**
 * Zoom about a fixed point, in CSS coordinates.
 *
 * The anchor is what makes a wheel-zoom feel right: the image pixel under the cursor must stay
 * under the cursor. Zooming about the container's origin instead makes the map slide away from
 * the pointer, which reads as a bug even though every number is "correct".
 */
export function zoomAbout(v: Viewport, anchor: Pixel, factor: number, limits: { min: number; max: number }): Viewport {
	if (!(factor > 0) || !Number.isFinite(factor)) return v;
	const next = Math.min(limits.max, Math.max(limits.min, v.scale * factor));
	if (next === v.scale) return v;
	// Solve for the offset that leaves the anchor's image pixel under the anchor.
	const ratio = next / v.scale;
	return {
		scale: next,
		offsetX: anchor.x - (anchor.x - v.offsetX) * ratio,
		offsetY: anchor.y - (anchor.y - v.offsetY) * ratio,
	};
}

/** Pan by a CSS-pixel delta. */
export function panBy(v: Viewport, dx: number, dy: number): Viewport {
	if (!Number.isFinite(dx) || !Number.isFinite(dy)) return v;
	return { ...v, offsetX: v.offsetX + dx, offsetY: v.offsetY + dy };
}

/** Is this image pixel inside the image at all? Used to refuse a readout off the edge. */
export function insideImage(image: Size, p: Pixel): boolean {
	return p.x >= 0 && p.y >= 0 && p.x <= image.width && p.y <= image.height;
}
