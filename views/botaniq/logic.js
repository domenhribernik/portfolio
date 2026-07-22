// DOM-free watering-schedule + formatting logic for the Botaniq plant tracker,
// unit-tested by tests/botaniq-logic.test.mjs (node --test tests/). The page's
// script.js imports this as an ES module. `now` is injected so the schedule
// math is deterministic under test; in the browser it defaults to the clock.

/**
 * Work out when a plant is next due for water, as a status label plus a CSS
 * status class (styled in style.css: status-ok / status-soon / status-overdue).
 *
 * @param {{last_watered: ?string, watering_min_days: number, watering_max_days: number}} plant
 * @param {Date} [now] current time, injected for deterministic tests
 * @returns {{text: string, statusClass: 'status-ok'|'status-soon'|'status-overdue'}}
 */
export function getWateringStatus(plant, now = new Date()) {
    if (!plant.last_watered) {
        return { text: 'Never watered', statusClass: 'status-overdue' };
    }

    const lastWatered = new Date(plant.last_watered);
    const diffDays = (now - lastWatered) / (1000 * 60 * 60 * 24);

    const minDays = plant.watering_min_days;
    const maxDays = plant.watering_max_days;

    // Past the outer bound: overdue.
    if (diffDays >= maxDays) {
        const overdueDays = Math.floor(diffDays - maxDays);
        return {
            text: overdueDays === 0 ? 'Water today!' : `Overdue by ${overdueDays} day${overdueDays !== 1 ? 's' : ''}`,
            statusClass: 'status-overdue',
        };
    }

    // Inside the watering window: due soon.
    if (diffDays >= minDays) {
        const remainingDays = Math.ceil(maxDays - diffDays);
        return {
            text: remainingDays <= 1 ? 'Water today or tomorrow' : `Water within ${remainingDays} days`,
            statusClass: 'status-soon',
        };
    }

    // Still before the window opens: count down to it.
    const daysUntilMin = Math.ceil(minDays - diffDays);
    if (daysUntilMin <= 0) {
        return { text: 'Water today', statusClass: 'status-soon' };
    }

    const hours = Math.floor((minDays - diffDays) * 24);
    if (hours < 24) {
        return { text: `${hours} hour${hours !== 1 ? 's' : ''} left`, statusClass: 'status-soon' };
    }

    return {
        text: `${daysUntilMin} day${daysUntilMin !== 1 ? 's' : ''} left`,
        statusClass: 'status-ok',
    };
}

/**
 * Turn a min/max watering window (in days) into a human frequency line,
 * e.g. "Every 5 to 7 days". Replaces the old free-text field: the schedule is
 * derived from the two numbers so the two can never disagree.
 * @param {number} min soonest it should be watered, in days
 * @param {number} max latest it should be watered, in days
 * @returns {string}
 */
export function wateringFrequencyText(min, max) {
    if (min === max) {
        return min === 1 ? 'Every day' : `Every ${min} days`;
    }
    return `Every ${min} to ${max} days`;
}

/** Append °C unless the value already carries a degree unit. */
export function formatTemp(temp) {
    if (!temp) return '';
    temp = temp.trim();
    if (temp.includes('°')) return temp;
    return temp + '°C';
}
