// Расчёт стартовой нормы КБЖУ. Работает и в браузере (window.HFCalc), и в Node (module.exports).
// Источники: Mifflin–St Jeor 1990 (Frankenfield 2005, МР 2.3.1.0253-21), Cunningham 1980 (при известном % жира),
// ISSN 2017 / Morton 2018 / Helms 2014 (белок), AHA/ACC/TOS 2013 (минимумы), Iraki 2019 (набор), EFSA (вода).
(function (root) {
  'use strict';

  const ACTIVITY = {
    // Только бытовая активность (без тренировок): тренировки и шаги сверх базы добавляются в свой день.
    sedentary: { k: 1.2,   steps: 4000,  label: 'Сидячий', hint: 'Офис, машина, до 4 тыс. шагов' },
    light:     { k: 1.375, steps: 7000,  label: 'Лёгкий',  hint: 'Немного пешком, 5–8 тыс. шагов' },
    moderate:  { k: 1.55,  steps: 10000, label: 'Средний', hint: 'Много на ногах: 8–12 тыс. шагов' },
    high:      { k: 1.725, steps: 13000, label: 'Высокий', hint: 'Физическая работа весь день' },
  };

  // rate — доля массы тела в неделю; protein — г/кг опорного веса; capShare — максимум дефицита/профицита от TDEE
  const GOALS = {
    lose_fast:    { label: 'Быстрое снижение',   hint: '≈1% веса в неделю, больше белка, чтобы сохранить мышцы', rate: -0.010, protein: 2.2, capShare: 0.25 },
    lose_healthy: { label: 'Здоровое снижение',  hint: '≈0,5% веса в неделю — мышцы сохраняются лучше всего',   rate: -0.005, protein: 2.0, capShare: 0.20 },
    maintain:     { label: 'Поддержание',        hint: 'Держать вес и улучшать состав тела',                     rate: 0,      protein: 1.6, capShare: 0 },
    gain_lean:    { label: 'Набор мышц',         hint: '≈0,25–0,5% веса в неделю, минимум лишнего жира',         rate: 0.0035, protein: 1.8, capShare: 0.15 },
  };

  const KCAL_PER_KG = 7700;         // упрощённо; для прогноза даём диапазон ±20% (Hall 2011)
  const round = (n, s = 1) => Math.round(n / s) * s;

  function bmr({ sex, age, height, weight, bodyFat }) {
    if (bodyFat > 3 && bodyFat < 60) return 22 * weight * (1 - bodyFat / 100) + 500;          // Cunningham
    return 10 * weight + 6.25 * height - 5 * age + (sex === 'm' ? 5 : -161);                    // Mifflin–St Jeor
  }

  function safety(p) {
    const bmi = p.weight / (p.height / 100) ** 2;
    const reasons = [];
    if (p.age < 18) reasons.push('до 18 лет');
    if (bmi < 18.5) reasons.push('ИМТ ниже 18,5');
    if (p.pregnant) reasons.push('беременность или кормление');
    return { bmi, deficitAllowed: reasons.length === 0, reasons };
  }

  function targets(p) {
    const s = safety(p);
    let goalKey = GOALS[p.goal] ? p.goal : 'maintain';
    if (!s.deficitAllowed && goalKey.startsWith('lose')) goalKey = 'maintain';
    const g = GOALS[goalKey];
    const b = bmr(p);
    const act = (ACTIVITY[p.activity] || ACTIVITY.light).k;
    const tdee = b * act;

    // дельта калорий из целевого темпа, ограниченная долей от TDEE
    let delta = (g.rate * p.weight * KCAL_PER_KG) / 7;
    if (g.rate < 0) delta = -Math.min(-delta, g.capShare * tdee, 1000);
    if (g.rate > 0) delta = Math.min(delta, g.capShare * tdee, 500);
    // нижняя граница — общепринятый минимум (AHA/ACC/TOS 2013), не BMR: иначе людям с большим весом почти не даётся дефицит
    const floor = p.sex === 'm' ? 1500 : 1200;
    const wanted = (g.rate * p.weight * KCAL_PER_KG) / 7;
    let kcal = Math.max(tdee + delta, g.rate < 0 ? floor : 0);
    const limited = g.rate !== 0 && Math.abs(kcal - tdee) < Math.abs(wanted) * 0.8;

    // опорный вес для белка/жира: при ИМТ > 30 считаем от веса при ИМТ 27
    const h2 = (p.height / 100) ** 2;
    const refW = s.bmi > 30 ? 27 * h2 : p.weight;
    let protein = g.protein * refW;
    let fat = Math.max(0.8 * refW, (0.25 * kcal) / 9);
    fat = Math.min(fat, (0.35 * kcal) / 9);
    let carbs = (kcal - protein * 4 - fat * 9) / 4;
    if (carbs < 50) { fat = Math.max((0.2 * kcal) / 9, fat - (50 - carbs) * 4 / 9); carbs = (kcal - protein * 4 - fat * 9) / 4; }

    const water = Math.min(3500, round(Math.max(p.sex === 'm' ? 2500 : 2000, 33 * refW), 250));
    const weeklyKg = ((kcal - tdee) * 7) / KCAL_PER_KG;
    let weeks = null;
    if (p.target && Math.abs(p.target - p.weight) > 0.5 && Math.sign(p.target - p.weight) === Math.sign(weeklyKg) && weeklyKg) {
      weeks = Math.abs(p.target - p.weight) / Math.abs(weeklyKg);
    }
    return {
      goal: goalKey, bmr: round(b), tdee: round(tdee), kcal: round(kcal, 10),
      p: round(protein), f: round(fat), c: round(Math.max(0, carbs)), fiber: round(kcal / 1000 * 14),
      water, weeklyKg: Math.round(weeklyKg * 100) / 100, weeks: weeks && Math.round(weeks),
      weeksRange: weeks && [Math.round(weeks * 0.8), Math.round(weeks * 1.2)], limited,
      targetConflict: Boolean(p.target && Math.abs(p.target - p.weight) > 0.5 && g.rate !== 0 && Math.sign(p.target - p.weight) !== Math.sign(g.rate)),
      bmi: Math.round(s.bmi * 10) / 10, safety: s,
    };
  }

  // калории за шаги сверх базового обмена: ≈0,0004 ккал × кг на шаг (MET ходьбы − 1)
  const stepsKcal = (steps, weight) => Math.round(steps * 0.0004 * weight);

  // Тренировки: MET по Compendium of Physical Activities (Ainsworth 2011, обновление 2024).
  // Считаем «чистые» калории сверх покоя: (MET − 1) × кг × часы. Точность ±30%.
  const ACTIVITIES = {
    gym:     { label: 'Зал',          hint: 'силовая, тренажёры',     met: [3.5, 5.0, 6.0] },
    street:  { label: 'Площадка',     hint: 'турник, брусья, воркаут', met: [3.8, 5.5, 8.0] },
    run:     { label: 'Бег',          hint: '8 / 10 / 12 км/ч',       met: [8.3, 9.8, 11.8] },
    walk:    { label: 'Ходьба',       hint: 'прогулка / быстрая / в гору', met: [3.0, 4.3, 6.0] },
    bike:    { label: 'Велосипед',    hint: 'спокойно / умеренно / быстро', met: [4.0, 6.8, 10.0] },
    swim:    { label: 'Плавание',     hint: 'спокойно / умеренно / интенсивно', met: [5.8, 7.0, 9.8] },
    hiit:    { label: 'Кардио, HIIT', hint: 'круговая, интервалы',     met: [5.0, 8.0, 10.0] },
    martial: { label: 'Единоборства', hint: 'бокс, борьба, ММА',       met: [5.5, 7.8, 10.3] },
    team:    { label: 'Игры',         hint: 'футбол, баскетбол, волейбол', met: [4.0, 7.0, 10.0] },
    yoga:    { label: 'Йога, растяжка', hint: 'хатха / пилатес / силовая', met: [2.3, 3.0, 4.0] },
    dance:   { label: 'Танцы',        hint: 'спокойно / активно / интенсивно', met: [3.0, 5.0, 7.3] },
    other:   { label: 'Другое',       hint: 'любая активность',        met: [3.0, 5.0, 7.0] },
  };
  const INTENSITY = ['Лёгкая', 'Средняя', 'Высокая'];
  function activityKcal(type, level, minutes, weight) {
    const a = ACTIVITIES[type] || ACTIVITIES.other;
    const met = a.met[Math.max(0, Math.min(2, level))];
    return Math.max(0, Math.round((met - 1) * weight * (minutes / 60)));
  }

  // Бонус к дневной норме: тренировки целиком (уровень активности их не включает) + шаги сверх базы уровня.
  // Если есть активные калории из «Здоровья»/браслета, из них вычитаем бытовую активность, уже заложенную в коэффициент.
  function dayBonus(p, acts, steps, activeKcal) {
    const w = p.weight || 75, lvl = ACTIVITY[p.activity] || ACTIVITY.light;
    const workouts = (acts || []).reduce((a, x) => a + activityKcal(x.type, x.level, x.min, w), 0);
    const manual = workouts + stepsKcal(Math.max(0, (steps || 0) - lvl.steps), w);
    const assumed = (lvl.k - 1.1) * bmr(p);
    const watch = activeKcal ? Math.max(0, Math.round(activeKcal - assumed)) : 0;
    return { kcal: Math.max(manual, watch), workouts, manual, watch, source: watch > manual ? 'health' : 'manual' };
  }

  // EWMA-тренд веса (α=0.1, как у сглаженных «трендовых» весов)
  function weightTrend(entries, alpha = 0.1) {
    const sorted = entries.slice().sort((a, b) => a.date.localeCompare(b.date));
    let t = null;
    return sorted.map(e => { t = t == null ? e.kg : t + alpha * (e.kg - t); return { date: e.date, kg: e.kg, trend: Math.round(t * 10) / 10 }; });
  }

  const api = { ACTIVITY, GOALS, ACTIVITIES, INTENSITY, bmr, targets, safety, stepsKcal, activityKcal, weightTrend, dayBonus };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HFCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
