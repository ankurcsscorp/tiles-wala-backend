export const roundMoney = (value) => Number((Number(value) || 0).toFixed(2));

export class SalesBonusValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SalesBonusValidationError";
  }
}

export const calculateSalesBonusRow = ({
  costPrice,
  sellingPrice,
  quantity,
  bonusRate,
  userType,
}) => {
  const normalizedCostPrice = Number.parseFloat(String(costPrice ?? ""));
  const normalizedSellingPrice = Number.parseFloat(String(sellingPrice ?? ""));
  const normalizedQuantity = Number.parseFloat(String(quantity ?? ""));
  const normalizedBonusRate = Number.parseFloat(String(bonusRate ?? ""));

  const validCostPrice = Number.isFinite(normalizedCostPrice) ? normalizedCostPrice : 0;
  const validSellingPrice = Number.isFinite(normalizedSellingPrice) ? normalizedSellingPrice : 0;
  const validQuantity = Number.isFinite(normalizedQuantity) && normalizedQuantity > 0 ? normalizedQuantity : 0;
  const validBonusRate = Number.isFinite(normalizedBonusRate) && normalizedBonusRate >= 0 ? normalizedBonusRate : 0;

  const totalCost = roundMoney(validCostPrice * validQuantity);
  const totalSellingAmount = roundMoney(validSellingPrice * validQuantity);
  const grossProfit = roundMoney(totalSellingAmount - totalCost);
  const grossBonus = roundMoney(Math.max(grossProfit, 0) * (validBonusRate / 100));
  const userBonus = roundMoney(
    userType === "Salesperson" ? grossBonus * 0.5 : grossBonus
  );

  return {
    totalCost,
    totalSellingAmount,
    grossProfit,
    grossBonus,
    userBonus,
  };
};

export const calculateSalesBonusSummary = (rows, userType) =>
  Object.fromEntries(
    Object.entries(
      rows.reduce(
        (acc, row) => {
          const result = calculateSalesBonusRow({
            ...row,
            userType,
          });

          acc.totalQuantity += Number(row.quantity || 0);
          acc.totalCost += result.totalCost;
          acc.totalSellingAmount += result.totalSellingAmount;
          acc.totalGrossProfit += result.grossProfit;
          acc.totalGrossBonus += result.grossBonus;
          acc.finalUserBonus += result.userBonus;
          return acc;
        },
        {
          totalQuantity: 0,
          totalCost: 0,
          totalSellingAmount: 0,
          totalGrossProfit: 0,
          totalGrossBonus: 0,
          finalUserBonus: 0,
        }
      )
    ).map(([key, value]) => [key, roundMoney(value)])
  );

const parseRequiredNumber = (value) => {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const MAX_DATABASE_NUMBER = 9999999999.99;

export const validateSalesBonusRows = (rows, selectedUserType, productCatalog) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new SalesBonusValidationError(
      "Add at least one product row to create a sales bonus record"
    );
  }

  if (rows.length > 100) {
    throw new SalesBonusValidationError("A record cannot contain more than 100 product rows");
  }

  const validUserTypes = new Set(["Tile Mistire", "Salesperson"]);
  if (!validUserTypes.has(selectedUserType)) {
    throw new SalesBonusValidationError("Select a valid user type for bonus allocation");
  }

  return rows.map((row, index) => {
    const productName = typeof row.productName === "string" ? row.productName.trim() : "";
    const product = productCatalog.find(
      (catalogProduct) => catalogProduct.product_name === productName
    );
    const costPrice = parseRequiredNumber(product?.default_cost_price);
    const sellingPrice = parseRequiredNumber(row.sellingPrice);
    const quantity = parseRequiredNumber(row.quantity);
    const configuredBonusRate = parseRequiredNumber(product?.default_bonus_percentage);
    const bonusRate =
      row.bonusRate === undefined || row.bonusRate === null
        ? configuredBonusRate
        : parseRequiredNumber(row.bonusRate);

    if (!productName || productName.length > 200) {
      throw new SalesBonusValidationError(
        `Product name is required and must be 200 characters or fewer for row ${index + 1}`
      );
    }

    if (!product) {
      throw new SalesBonusValidationError(
        `Product in row ${index + 1} is not available in the active catalog`
      );
    }

    if (
      costPrice === null ||
      sellingPrice === null ||
      quantity === null ||
      bonusRate === null ||
      costPrice < 0 ||
      costPrice > MAX_DATABASE_NUMBER ||
      sellingPrice < 0 ||
      sellingPrice > MAX_DATABASE_NUMBER ||
      quantity <= 0 ||
      quantity > MAX_DATABASE_NUMBER ||
      bonusRate < 0 ||
      bonusRate > 100
    ) {
      throw new SalesBonusValidationError(
        `Row ${index + 1} contains an invalid product entry`
      );
    }

    const computed = calculateSalesBonusRow({
      costPrice,
      sellingPrice,
      quantity,
      bonusRate,
      userType: selectedUserType,
    });

    if (
      computed.totalCost > MAX_DATABASE_NUMBER ||
      computed.totalSellingAmount > MAX_DATABASE_NUMBER ||
      Math.abs(computed.grossProfit) > MAX_DATABASE_NUMBER
    ) {
      throw new SalesBonusValidationError(
        `Row ${index + 1} exceeds the supported monetary limits`
      );
    }

    return {
      productName,
      costPrice,
      sellingPrice,
      quantity,
      bonusRate,
      ...computed,
    };
  });
};

export const validateSalesBonusSummary = (summary) => {
  if (
    Object.values(summary).some(
      (value) => !Number.isFinite(value) || Math.abs(value) > MAX_DATABASE_NUMBER
    )
  ) {
    throw new SalesBonusValidationError(
      "The combined sales bonus amounts exceed the supported limits"
    );
  }

  return summary;
};
