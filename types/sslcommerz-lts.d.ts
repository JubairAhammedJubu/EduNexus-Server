declare module "sslcommerz-lts" {
  class SSLCommerz {
    constructor(
      storeId: string,
      storePassword: string,
      isLive: boolean
    );

    init(data: Record<string, any>): Promise<any>;

    validate(data: Record<string, any>): Promise<any>;

    initiate(data: Record<string, any>): Promise<any>;
  }

  export = SSLCommerz;
}