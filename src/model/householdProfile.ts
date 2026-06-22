import type {
  ChildSituation,
  ConsumableTemplate,
  CookingFrequency,
  HomeSize,
  HouseholdProfile,
  LaundryFrequency,
  PetSituation,
  ResidentCount
} from "../types"

export const PROFILE_OPTIONS = {
  residentCount: [
    { value: 1 as ResidentCount, label: "1 人" },
    { value: 2 as ResidentCount, label: "2 人" },
    { value: 3 as ResidentCount, label: "3 人" },
    { value: 4 as ResidentCount, label: "4 人及以上" }
  ],
  children: [
    { value: "none" as ChildSituation, label: "没有" },
    { value: "infant" as ChildSituation, label: "婴幼儿" },
    { value: "schoolAge" as ChildSituation, label: "学龄儿童" },
    { value: "teen" as ChildSituation, label: "青少年" }
  ],
  pets: [
    { value: "none" as PetSituation, label: "没有" },
    { value: "cat" as PetSituation, label: "猫" },
    { value: "dog" as PetSituation, label: "狗" },
    { value: "catAndDog" as PetSituation, label: "猫狗都有" },
    { value: "other" as PetSituation, label: "其他" }
  ],
  cookingFrequency: [
    { value: "rarely" as CookingFrequency, label: "几乎不做" },
    { value: "sometimes" as CookingFrequency, label: "偶尔" },
    { value: "often" as CookingFrequency, label: "经常" },
    { value: "daily" as CookingFrequency, label: "基本每天" }
  ],
  laundryFrequency: [
    { value: "low" as LaundryFrequency, label: "每周 1-2 次" },
    { value: "medium" as LaundryFrequency, label: "每周 3-5 次" },
    { value: "daily" as LaundryFrequency, label: "几乎每天" }
  ],
  homeSize: [
    { value: "oneBedroom" as HomeSize, label: "一居" },
    { value: "twoBedroom" as HomeSize, label: "两居" },
    { value: "threePlus" as HomeSize, label: "三居及以上" }
  ]
}

export function createDefaultHouseholdProfile(now = Date.now()): HouseholdProfile {
  return {
    residentCount: 2,
    children: "none",
    pets: "none",
    cookingFrequency: "sometimes",
    laundryFrequency: "medium",
    homeSize: "twoBedroom",
    createdAt: now,
    updatedAt: now
  }
}

const RESIDENT_FACTORS: Record<ResidentCount, number> = { 1: 1.2, 2: 1, 3: 0.86, 4: 0.74 }
const COOKING_FACTORS: Record<CookingFrequency, number> = { rarely: 1.3, sometimes: 1.08, often: 0.88, daily: 0.76 }
const LAUNDRY_FACTORS: Record<LaundryFrequency, number> = { low: 1.2, medium: 1, daily: 0.78 }
const HOME_FACTORS: Record<HomeSize, number> = { oneBedroom: 1.12, twoBedroom: 1, threePlus: 0.86 }

export function calculateHouseholdCycleFactor(template: ConsumableTemplate, profile: HouseholdProfile): number {
  let factor = 1
  if (template.influenceFactors.includes("residents")) factor *= RESIDENT_FACTORS[profile.residentCount]
  if (template.influenceFactors.includes("cooking")) factor *= COOKING_FACTORS[profile.cookingFrequency]
  if (template.influenceFactors.includes("laundry")) factor *= LAUNDRY_FACTORS[profile.laundryFrequency]
  if (template.influenceFactors.includes("homeSize")) factor *= HOME_FACTORS[profile.homeSize]
  if (template.influenceFactors.includes("children") && profile.children !== "none") {
    factor *= profile.children === "infant" ? 0.78 : 0.9
  }
  if (template.influenceFactors.includes("pets") && profile.pets !== "none") {
    factor *= profile.pets === "catAndDog" ? 0.8 : 0.9
  }
  return Math.min(1.55, Math.max(0.55, factor))
}
